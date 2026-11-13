import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { resolveAbsoluteDirOverride } from '../../../shared/absolute-dir-override'

// Accept Pi/OMP home, agent, or sessions paths.
export function normalizeAgentSessionsDir(
  rawValue: string,
  agentHomeDirName: '.pi' | '.omp'
): string {
  const trimmed = rawValue.trim()
  if (!trimmed) {
    return join(homedir(), agentHomeDirName, 'agent', 'sessions')
  }
  const normalized = trimmed.replace(/[\\/]+$/, '')
  const leaf = basename(normalized)
  if (leaf === 'sessions') {
    return normalized
  }
  if (leaf === 'agent') {
    return join(normalized, 'sessions')
  }
  if (leaf === agentHomeDirName) {
    return join(normalized, 'agent', 'sessions')
  }
  return normalized
}

function defaultPrimeAgentSessionsDir(): string {
  return join(homedir(), '.prime', 'agent', 'sessions')
}

// Pi/Prime expand leading ~ themselves; other CLIs such as Grok treat it literally.
function absoluteConfiguredDir(rawValue: string): string | null {
  const expanded = rawValue === '~' ? homedir() : rawValue.replace(/^~(?=[\\/])/, homedir())
  const normalized = expanded.replace(/[\\/]+$/, '')
  return resolveAbsoluteDirOverride(normalized, '') || null
}

// Prime always appends sessions, even when the configured agent directory is named sessions.
export function normalizePrimeAgentSessionsDir(rawAgentDir: string): string {
  const agentDir = absoluteConfiguredDir(rawAgentDir.trim())
  return agentDir ? join(agentDir, 'sessions') : defaultPrimeAgentSessionsDir()
}

// Explicit session-root overrides outrank the agent directory and are used verbatim.
export function primeAgentSessionsDirFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  const sessionDir =
    env.PRIME_AGENT_SESSION_DIR?.trim() || env.PRIME_AGENT_CODING_AGENT_SESSION_DIR?.trim()
  if (sessionDir) {
    return absoluteConfiguredDir(sessionDir) ?? defaultPrimeAgentSessionsDir()
  }
  const agentDir = env.PRIME_AGENT_CODING_AGENT_DIR?.trim()
  return agentDir ? normalizePrimeAgentSessionsDir(agentDir) : defaultPrimeAgentSessionsDir()
}

export function piSessionHistorySessionsDir(): string {
  return normalizeAgentSessionsDir(
    process.env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), '.pi', 'agent', 'sessions'),
    '.pi'
  )
}
