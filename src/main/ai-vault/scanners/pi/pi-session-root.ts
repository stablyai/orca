import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { resolveAbsoluteDirOverride } from '../../../../shared/absolute-dir-override'
import { asRecord } from '../../session-scanner-record-value'
import { normalizeAgentSessionsDir } from '../../session-scanner-values'

// Pi resolves a session root as --session-dir, then PI_CODING_AGENT_SESSION_DIR, then the
// user-level settings.json sessionDir, then the agent home. A relative value resolves against the
// writer's working directory, which the scanner has no single answer for, so it is skipped instead
// of being guessed at.
function absoluteDir(value: string | undefined, home: string): string | undefined {
  const trimmed = value?.trim() ?? ''
  if (!trimmed) {
    return undefined
  }
  const expanded = trimmed === '~' ? home : trimmed.replace(/^~(?=[\\/])/, home)
  return resolveAbsoluteDirOverride(expanded.replace(/[\\/]+$/, ''), '') || undefined
}

function agentHomeDir(env: NodeJS.ProcessEnv, home: string): string {
  return absoluteDir(env.PI_CODING_AGENT_DIR, home) ?? join(home, '.pi', 'agent')
}

// One small read per root resolution, not per transcript file; a missing or unreadable file means
// the setting is absent, which keeps discovery working on hosts that never wrote one.
function settingsSessionDir(agentHome: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(agentHome, 'settings.json'), 'utf8'))
    const record = asRecord(parsed)
    return typeof record?.sessionDir === 'string' ? record.sessionDir : undefined
  } catch {
    return undefined
  }
}

function defaultPiAgentSessionsDir(home: string): string {
  return join(home, '.pi', 'agent', 'sessions')
}

export function resolvePiSessionsDir(
  options: { env?: NodeJS.ProcessEnv; homeDir?: string } = {}
): string {
  const env = options.env ?? process.env
  const home = options.homeDir ?? homedir()
  return (
    absoluteDir(env.PI_CODING_AGENT_SESSION_DIR, home) ??
    absoluteDir(settingsSessionDir(agentHomeDir(env, home)), home) ??
    normalizeAgentSessionsDir(env.PI_CODING_AGENT_DIR?.trim() ?? '', '.pi')
  )
}

/**
 * Keep history from before an override took effect: the resolved root and the default agent home.
 * An explicit scan option still replaces both, matching the Claude and OMP root handling.
 */
export function piSessionsRootDirs(
  options: { env?: NodeJS.ProcessEnv; homeDir?: string; sessionsDir?: string } = {}
): string[] {
  if (options.sessionsDir !== undefined) {
    return [options.sessionsDir]
  }
  const home = options.homeDir ?? homedir()
  return [resolvePiSessionsDir(options), defaultPiAgentSessionsDir(home)].filter(
    (root, index, roots) => root.length > 0 && roots.indexOf(root) === index
  )
}
