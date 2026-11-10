import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { resolveAbsoluteDirOverride } from '../../../../shared/absolute-dir-override'
import { asRecord } from '../../session-scanner-record-value'
import { normalizeAgentSessionsDir } from '../../session-scanner-values'

// Pi resolves a session root as --session-dir, then PI_CODING_AGENT_SESSION_DIR, then the
// user-level settings.json sessionDir, then the agent home. A configured value that Pi would
// resolve against the writer's working directory is skipped, because the scanner has no single
// answer for it.
function absoluteDir(value: string | undefined, home: string): string | undefined {
  const trimmed = value?.trim() ?? ''
  if (!trimmed) {
    return undefined
  }
  const expanded = trimmed === '~' ? home : trimmed.replace(/^~(?=[\\/])/, home)
  return resolveAbsoluteDirOverride(expanded.replace(/[\\/]+$/, ''), '') || undefined
}

/** Pi's agent directory: the configured override when usable, otherwise the default home. */
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

function normalizedAgentSessionsDir(env: NodeJS.ProcessEnv, home: string): string {
  return normalizeAgentSessionsDir(agentHomeDir(env, home), '.pi')
}

/** The session root Pi would use: the explicit override, the settings value, or the agent home. */
export function resolvePiSessionsDir(
  options: { env?: NodeJS.ProcessEnv; homeDir?: string } = {}
): string {
  const env = options.env ?? process.env
  const home = options.homeDir ?? homedir()
  return (
    absoluteDir(env.PI_CODING_AGENT_SESSION_DIR, home) ??
    absoluteDir(settingsSessionDir(agentHomeDir(env, home)), home) ??
    normalizedAgentSessionsDir(env, home)
  )
}

/**
 * Roots to index: the resolved root and the configured agent home, so transcripts written before an
 * override stay visible. An explicit scan option replaces both, matching the Claude and OMP roots.
 */
export function piSessionsRootDirs(
  options: { env?: NodeJS.ProcessEnv; homeDir?: string; sessionsDir?: string } = {}
): string[] {
  if (options.sessionsDir !== undefined) {
    return [options.sessionsDir]
  }
  const env = options.env ?? process.env
  const home = options.homeDir ?? homedir()
  const roots = [resolvePiSessionsDir(options), normalizedAgentSessionsDir(env, home)]
  return roots.filter((root, index) => root.length > 0 && roots.indexOf(root) === index)
}
