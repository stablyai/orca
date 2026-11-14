import { homedir } from 'node:os'
import { join } from 'node:path'

/** Vibe keeps all state under VIBE_HOME (default ~/.vibe) and catalogs sessions in logs/session/unified. */
export function resolveVibeHome(override?: string): string {
  const explicit = override?.trim() || process.env.VIBE_HOME?.trim()
  return explicit || join(homedir(), '.vibe')
}

export function resolveVibeSessionIndexPath(home = resolveVibeHome()): string {
  return join(home, 'logs', 'session', 'unified', '.session-index.json')
}

export function resolveVibeConfigPath(home = resolveVibeHome()): string {
  return join(home, 'config.toml')
}
