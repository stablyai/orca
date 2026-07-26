import { execFile } from 'node:child_process'
import { basename } from 'node:path'
import { homedir, userInfo } from 'node:os'
import { promisify } from 'node:util'
import { installRemoteManagedAgentHooks } from './remote-managed-hook-installers'
import { createManagedHookLocalFilesystem } from './managed-hook-local-filesystem'
import { withManagedHookInstallLock } from './managed-hook-install-lock'
import {
  readManagedHookHostIdentity,
  scopeManagedHookHostIdentity
} from './managed-hook-owner-identity'

const execFileAsync = promisify(execFile)
const GROK_HOME_MAX_LENGTH = 4096
const GROK_HOME_PROBE_TIMEOUT_MS = 8_000

export type ManagedHookInstallSummary = {
  installers: number
  errors: number
}

function defaultGrokHome(home: string): string {
  return `${home.replace(/\/+$/, '') || home}/.grok`
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

export async function installManagedHooks(options?: {
  signal?: AbortSignal
  hostKeyFingerprint?: string
}): Promise<ManagedHookInstallSummary> {
  options?.signal?.throwIfAborted()
  const home = homedir()
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
          grokHomeDir,
          signal: options?.signal
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
