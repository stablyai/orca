import { execFile } from 'node:child_process'
import { basename } from 'node:path'
import { homedir, userInfo } from 'node:os'
import { promisify } from 'node:util'
import { installRemoteManagedAgentHooks } from './remote-managed-hook-installers'
import type { AgentHookTarget } from '../../shared/agent-hook-types'
import { createManagedHookLocalFilesystem } from './managed-hook-local-filesystem'
import { withManagedHookInstallLock } from './managed-hook-install-lock'
import {
  readManagedHookHostIdentity,
  scopeManagedHookHostIdentity
} from './managed-hook-owner-identity'

const execFileAsync = promisify(execFile)
const AGENT_HOME_MAX_LENGTH = 4096
const AGENT_HOME_PROBE_TIMEOUT_MS = 8_000

export type ManagedHookInstallSummary = {
  installers: number
  errors: number
}

function defaultAgentHome(home: string, dirName: string): string {
  return `${home.replace(/\/+$/, '') || home}/${dirName}`
}

function hasControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.charCodeAt(0)
    return code <= 0x1f || code === 0x7f
  })
}

function normalizeAgentHome(candidate: string): string | null {
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

function resolveLoginShell(): string {
  const candidate = process.env.SHELL || userInfo().shell || '/bin/sh'
  if (!candidate.startsWith('/') || candidate.includes('\\') || hasControlCharacter(candidate)) {
    return '/bin/sh'
  }
  return candidate
}

async function resolveRelayAgentHome(
  envName: 'GROK_HOME' | 'KIRO_HOME',
  fallback: string,
  signal?: AbortSignal
): Promise<string> {
  try {
    const shell = resolveLoginShell()
    const shellName = basename(shell)
    const mode = shellName === 'sh' || shellName === 'dash' ? '-c' : '-lc'
    // Why: agent PTYs start login shells, so read the same profile-derived
    // home override without opening two additional SSH exec channels.
    const { stdout } = await execFileAsync(
      shell,
      [mode, `printenv ${envName} | head -c ${AGENT_HOME_MAX_LENGTH + 1}`],
      { encoding: 'utf8', timeout: AGENT_HOME_PROBE_TIMEOUT_MS, signal }
    )
    return normalizeAgentHome(stdout.split(/\r?\n/, 1)[0] ?? '') ?? fallback
  } catch {
    signal?.throwIfAborted()
    return fallback
  }
}

export function resolveRelayGrokHome(home: string, signal?: AbortSignal): Promise<string> {
  return resolveRelayAgentHome('GROK_HOME', defaultAgentHome(home, '.grok'), signal)
}

/** `$KIRO_HOME` replaces `~/.kiro` outright, for agent configs and sessions alike. */
export function resolveRelayKiroHome(home: string, signal?: AbortSignal): Promise<string> {
  return resolveRelayAgentHome('KIRO_HOME', defaultAgentHome(home, '.kiro'), signal)
}

export async function installManagedHooks(options?: {
  signal?: AbortSignal
  hostKeyFingerprint?: string
  agents?: readonly AgentHookTarget[]
  claudeVersion?: string
}): Promise<ManagedHookInstallSummary> {
  options?.signal?.throwIfAborted()
  // Why: empty/omitted allowlist fails closed before any home/host probes.
  const agents = options?.agents ?? []
  if (agents.length === 0) {
    return { installers: 0, errors: 0 }
  }
  const home = homedir()
  // Why parallel: each probe may wait out its own login-shell timeout.
  const [grokHomeDir, kiroHomeDir] = await Promise.all([
    agents.includes('grok') ? resolveRelayGrokHome(home, options?.signal) : undefined,
    agents.includes('kiro') ? resolveRelayKiroHome(home, options?.signal) : undefined
  ])
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
          kiroHomeDir,
          signal: options?.signal,
          agents,
          ...(options?.claudeVersion ? { claudeVersion: options.claudeVersion } : {})
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
