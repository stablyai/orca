import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

// Why: the background quota poller spawns the real `codex` binary to read rate
// limits. For users who installed Codex but never signed in, that spawn can
// only fail — and worse, surfaces as an unexpected Codex process starting in
// the background. A signed-in Codex always writes an auth.json under its
// CODEX_HOME, so gating the fetch on that file keeps the poller silent until
// the user actually uses Codex.
export function codexAuthExists(codexHomePath?: string | null): boolean {
  // Mirror Codex's own home resolution: an explicit managed-account home wins,
  // then CODEX_HOME, then the default ~/.codex.
  const home = codexHomePath ?? process.env.CODEX_HOME ?? join(homedir(), '.codex')
  try {
    return existsSync(join(home, 'auth.json'))
  } catch {
    return false
  }
}
