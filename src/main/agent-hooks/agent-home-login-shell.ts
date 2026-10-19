import { basename } from 'node:path'
import { userInfo } from 'node:os'
import { runProcess } from '@orca/process-host'

const AGENT_HOME_MAX_LENGTH = 4096
const AGENT_HOME_PROBE_TIMEOUT_MS = 8_000

type AgentHomeEnvName = 'GROK_HOME' | 'KIRO_HOME'

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

/** The login shell's value for `envName`, or null when unset, invalid, or unreadable. */
async function readLoginShellAgentHome(
  envName: AgentHomeEnvName,
  signal?: AbortSignal
): Promise<string | null> {
  try {
    const shell = resolveLoginShell()
    const shellName = basename(shell)
    const mode = shellName === 'sh' || shellName === 'dash' ? '-c' : '-lc'
    // Why: agent PTYs start login shells, so read the same profile-derived home override.
    const result = await runProcess({
      program: shell,
      args: [mode, `printenv ${envName} | head -c ${AGENT_HOME_MAX_LENGTH + 1}`],
      timeoutMs: AGENT_HOME_PROBE_TIMEOUT_MS,
      maxOutputBytes: AGENT_HOME_MAX_LENGTH * 2,
      ...(signal ? { signal } : {})
    })
    signal?.throwIfAborted()
    if (result.timedOut || result.code !== 0) {
      return null
    }
    return normalizeAgentHome(result.stdout.split(/\r?\n/, 1)[0] ?? '')
  } catch {
    signal?.throwIfAborted()
    return null
  }
}

export async function resolveLoginShellGrokHome(
  home: string,
  signal?: AbortSignal
): Promise<string> {
  return (await readLoginShellAgentHome('GROK_HOME', signal)) ?? defaultAgentHome(home, '.grok')
}

/** `$KIRO_HOME` replaces `~/.kiro` outright, for agent configs and sessions alike. */
export async function resolveLoginShellKiroHome(
  home: string,
  signal?: AbortSignal
): Promise<string> {
  return (await readLoginShellAgentHome('KIRO_HOME', signal)) ?? defaultAgentHome(home, '.kiro')
}

/**
 * A process not started from a login shell (orcad over SSH) misses profile-only agent homes, so
 * its installers would write where the agents' login-shell panes never look. Never throws.
 */
export async function adoptLoginShellAgentHomes(
  env: NodeJS.ProcessEnv = process.env
): Promise<void> {
  if (process.platform === 'win32') {
    return
  }
  const names: AgentHomeEnvName[] = ['GROK_HOME', 'KIRO_HOME']
  await Promise.all(
    names
      .filter((name) => !env[name])
      .map(async (name) => {
        const value = await readLoginShellAgentHome(name)
        if (value && !env[name]) {
          env[name] = value
        }
      })
  )
}
