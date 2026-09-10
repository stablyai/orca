import { execFile } from 'node:child_process'
import { basename } from 'node:path'
import { homedir, userInfo } from 'node:os'
import { promisify } from 'node:util'
import { installRemoteManagedAgentHooks } from './remote-managed-hook-installers'
import type { AgentHookTarget } from '../../shared/agent-hook-types'
import { createManagedHookLocalFilesystem } from './managed-hook-local-filesystem'
import { withManagedHookInstallLock } from './managed-hook-install-lock'
import { CODEX_READ_ONLY_APP_SERVER_ARGS } from '../codex-cli/codex-read-only-app-server-args'
import { runCodexAppServerSession } from '../codex/codex-app-server-session'
import {
  readManagedHookHostIdentity,
  scopeManagedHookHostIdentity
} from './managed-hook-owner-identity'

const execFileAsync = promisify(execFile)
const CODEX_HOME_MAX_LENGTH = 4096
const CODEX_HOME_PROBE_TIMEOUT_MS = 8_000
const GROK_HOME_MAX_LENGTH = 4096
const GROK_HOME_PROBE_TIMEOUT_MS = 8_000

export type ManagedHookInstallSummary = {
  installers: number
  errors: number
}

function defaultGrokHome(home: string): string {
  return `${home.replace(/\/+$/, '') || home}/.grok`
}

function defaultCodexHome(home: string): string {
  return `${home.replace(/\/+$/, '') || home}/.codex`
}

function hasControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.charCodeAt(0)
    return code <= 0x1f || code === 0x7f
  })
}

function normalizeGrokHome(candidate: string): string | null {
  if (
    candidate.length === 0 ||
    candidate.length > GROK_HOME_MAX_LENGTH ||
    candidate !== candidate.trim() ||
    !candidate.startsWith('/') ||
    candidate.includes('\\') ||
    hasControlCharacter(candidate)
  ) {
    return null
  }
  return candidate.replace(/\/+$/, '') || '/'
}

function normalizeCodexHome(candidate: unknown): string | null {
  if (
    typeof candidate !== 'string' ||
    candidate.length === 0 ||
    candidate.length > CODEX_HOME_MAX_LENGTH ||
    candidate !== candidate.trim() ||
    !candidate.startsWith('/') ||
    candidate.includes('\\') ||
    hasControlCharacter(candidate)
  ) {
    return null
  }
  const normalized = candidate.replace(/\/+$/, '') || '/'
  const segments = normalized.split('/').slice(1)
  if (
    normalized.startsWith('//') ||
    segments.some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    return null
  }
  return normalized
}

/**
 * The shell an agent PTY starts, and the flag that makes it read the user's
 * profile — which is what puts a launcher wrapper's directory on `PATH`.
 */
function loginShellInvocation(): { shell: string; flag: string } {
  const shell = resolveLoginShell()
  const shellName = basename(shell)
  return { shell, flag: shellName === 'sh' || shellName === 'dash' ? '-c' : '-lc' }
}

function resolveLoginShell(): string {
  const candidate = process.env.SHELL || userInfo().shell || '/bin/sh'
  if (!candidate.startsWith('/') || candidate.includes('\\') || hasControlCharacter(candidate)) {
    return '/bin/sh'
  }
  return candidate
}

export async function resolveRelayGrokHome(home: string, signal?: AbortSignal): Promise<string> {
  const fallback = defaultGrokHome(home)
  try {
    const shell = resolveLoginShell()
    const shellName = basename(shell)
    const mode = shellName === 'sh' || shellName === 'dash' ? '-c' : '-lc'
    // Why: agent PTYs start login shells, so read the same profile-derived
    // GROK_HOME without opening two additional SSH exec channels.
    const { stdout } = await execFileAsync(
      shell,
      [mode, `printenv GROK_HOME | head -c ${GROK_HOME_MAX_LENGTH + 1}`],
      { encoding: 'utf8', timeout: GROK_HOME_PROBE_TIMEOUT_MS, signal }
    )
    return normalizeGrokHome(stdout.split(/\r?\n/, 1)[0] ?? '') ?? fallback
  } catch {
    signal?.throwIfAborted()
    return fallback
  }
}

export async function resolveRelayCodexHome(home: string, signal?: AbortSignal): Promise<string> {
  const fallback = defaultCodexHome(home)
  try {
    signal?.throwIfAborted()
    // Why the login shell: `resolveCodexCommand()` reads this process's PATH, and
    // the relay starts over a non-login SSH exec whose PATH has no `~/.local/bin`.
    // It would resolve the real binary and never see the launcher wrapper that
    // #19598 is about — the wrapper is reachable only once the profile has run.
    const { shell, flag } = loginShellInvocation()
    const resolvedHome = await runCodexAppServerSession(
      {
        command: shell,
        args: [flag, `exec codex ${CODEX_READ_ONLY_APP_SERVER_ARGS.join(' ')}`],
        // Why null: the launcher is the shell, not the CLI, so there is no host
        // CLI path to pair a `node` against — the wsl.exe case.
        cliPath: null,
        // Why pin HOME: parent and child must agree on which account is being
        // configured. Why strip: Orca exports CODEX_HOME/ORCA_CODEX_HOME for its
        // own managed accounts, and reading one back would report Orca's answer
        // as if the host user had redirected there. A redirect the user's profile
        // or wrapper sets is unaffected — the login shell re-exports it.
        env: { HOME: home },
        envToDelete: ['CODEX_HOME', 'ORCA_CODEX_HOME'],
        timeoutMs: CODEX_HOME_PROBE_TIMEOUT_MS
      },
      async (_rpc, initializeResult) =>
        normalizeCodexHome(
          initializeResult && typeof initializeResult === 'object'
            ? (initializeResult as { codexHome?: unknown }).codexHome
            : undefined
        )
    )
    signal?.throwIfAborted()
    return resolvedHome ?? fallback
  } catch {
    signal?.throwIfAborted()
    return fallback
  }
}

export async function installManagedHooks(options?: {
  signal?: AbortSignal
  hostKeyFingerprint?: string
  agents?: readonly AgentHookTarget[]
}): Promise<ManagedHookInstallSummary> {
  options?.signal?.throwIfAborted()
  // Why: empty/omitted allowlist fails closed before any home/host probes.
  const agents = options?.agents ?? []
  if (agents.length === 0) {
    return { installers: 0, errors: 0 }
  }
  const home = homedir()
  const resolvedCodexHome = agents.includes('codex')
    ? await resolveRelayCodexHome(home, options?.signal)
    : undefined
  // Why: an explicit dir changes the remote hook script layout. Keep the
  // legacy ~/.codex contract when the probe confirms or falls back to it.
  const codexHomeDir = resolvedCodexHome === defaultCodexHome(home) ? undefined : resolvedCodexHome
  options?.signal?.throwIfAborted()
  const grokHomeDir = await resolveRelayGrokHome(home, options?.signal)
  options?.signal?.throwIfAborted()
  const hostIdentity = scopeManagedHookHostIdentity(
    await readManagedHookHostIdentity(),
    options?.hostKeyFingerprint
  )
  return await withManagedHookInstallLock(
    home,
    options?.signal,
    async () => {
      const results = await installRemoteManagedAgentHooks(
        createManagedHookLocalFilesystem(),
        home,
        {
          codexHomeDir,
          grokHomeDir,
          signal: options?.signal,
          agents
        }
      )
      return {
        installers: results.length,
        errors: results.filter((result) => result.state === 'error').length
      }
    },
    hostIdentity
  )
}
