import { execFile } from 'node:child_process'
import { basename } from 'node:path'
import { homedir, userInfo } from 'node:os'
import { promisify } from 'node:util'
import { installRemoteManagedAgentHooks } from './remote-managed-hook-installers'
import { probeCodexHomeViaAppServer } from './codex-app-server-home-probe'
import type { AgentHookTarget } from '../../shared/agent-hook-types'
import { createManagedHookLocalFilesystem } from './managed-hook-local-filesystem'
import { withManagedHookInstallLock } from './managed-hook-install-lock'
import {
  readManagedHookHostIdentity,
  scopeManagedHookHostIdentity
} from './managed-hook-owner-identity'

const execFileAsync = promisify(execFile)
const AGENT_HOME_MAX_LENGTH = 4096
const GROK_HOME_PROBE_TIMEOUT_MS = 8_000

export type ManagedHookInstallSummary = {
  installers: number
  errors: number
}

function defaultAgentHome(home: string, directoryName: string): string {
  return `${home.replace(/\/+$/, '') || home}/${directoryName}`
}

function hasControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.charCodeAt(0)
    return code <= 0x1f || code === 0x7f
  })
}

/** Shared by every agent home read off a host: absolute POSIX, no smuggled control bytes. */
function normalizePosixAgentHome(candidate: string): string | null {
  if (
    candidate.length === 0 ||
    candidate.length > AGENT_HOME_MAX_LENGTH ||
    candidate !== candidate.trim() ||
    !candidate.startsWith('/') ||
    candidate.includes('\\') ||
    hasControlCharacter(candidate)
  ) {
    return null
  }
  return candidate.replace(/\/+$/, '') || '/'
}

/**
 * The shell an agent PTY would start, and the flag that makes it read the
 * user's profile — which is what puts a launcher wrapper on `PATH`.
 */
function loginShellInvocation(): { shell: string; flag: string } {
  const candidate = process.env.SHELL || userInfo().shell || '/bin/sh'
  const shell =
    !candidate.startsWith('/') || candidate.includes('\\') || hasControlCharacter(candidate)
      ? '/bin/sh'
      : candidate
  const shellName = basename(shell)
  return { shell, flag: shellName === 'sh' || shellName === 'dash' ? '-c' : '-lc' }
}

export async function resolveRelayGrokHome(home: string, signal?: AbortSignal): Promise<string> {
  const fallback = defaultAgentHome(home, '.grok')
  try {
    const { shell, flag } = loginShellInvocation()
    // Why: agent PTYs start login shells, so read the same profile-derived
    // GROK_HOME without opening two additional SSH exec channels.
    const { stdout } = await execFileAsync(
      shell,
      [flag, `printenv GROK_HOME | head -c ${AGENT_HOME_MAX_LENGTH + 1}`],
      { encoding: 'utf8', timeout: GROK_HOME_PROBE_TIMEOUT_MS, signal }
    )
    return normalizePosixAgentHome(stdout.split(/\r?\n/, 1)[0] ?? '') ?? fallback
  } catch {
    signal?.throwIfAborted()
    return fallback
  }
}

/**
 * Where this host's Codex actually keeps its config.
 *
 * `printenv CODEX_HOME` is not enough: a launcher wrapper exports it inside the
 * script and `exec`s the real binary, so it never reaches the parent shell
 * (#19598). Codex's own app-server handshake reports the value the wrapper set,
 * which is the only authority on the question. Anything else — no Codex on
 * PATH, a CLI too old for the handshake, a timeout, a non-POSIX answer — falls
 * back to `~/.codex`, the incumbent behaviour.
 */
export async function resolveRelayCodexHome(
  home: string,
  agents: readonly AgentHookTarget[],
  signal?: AbortSignal,
  probe: typeof probeCodexHomeViaAppServer = probeCodexHomeViaAppServer
): Promise<string> {
  const fallback = defaultAgentHome(home, '.codex')
  // Why: only a positively detected Codex pays for the probe; other hosts must
  // not start an app-server for a CLI the user never installed.
  if (!agents.includes('codex')) {
    return fallback
  }
  const { shell, flag } = loginShellInvocation()
  const reported = await probe({
    loginShell: shell,
    loginShellFlag: flag,
    ...(signal ? { signal } : {})
  })
  return (reported === null ? null : normalizePosixAgentHome(reported.trim())) ?? fallback
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
  const grokHomeDir = await resolveRelayGrokHome(home, options?.signal)
  options?.signal?.throwIfAborted()
  const codexHomeDir = await resolveRelayCodexHome(home, agents, options?.signal)
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
