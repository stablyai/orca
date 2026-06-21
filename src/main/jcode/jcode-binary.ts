// Why: jcode is installed via cargo. Under Electron the inherited PATH is often
// empty/minimal, so we can't rely on a bare `jcode`. Prefer resolving it from
// the user's LOGIN shell (which sources their profile and has the real PATH,
// e.g. ~/.cargo/bin), and fall back to the pinned cargo path only if that fails.
// The fallback keeps parity with the desktop prototype / CLI verification path.
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'

const JCODE_BIN_FALLBACK = '/Users/vinny/.cargo/bin/jcode'

let cachedJcodeBin: string | null = null

/** Resolve the jcode binary path once, lazily. Tries the user's login shell
 *  (so the real PATH from their profile applies) via `command -v jcode`; on any
 *  failure or empty result, falls back to the pinned cargo path if it exists,
 *  else the bare name (lets spawn surface a clear ENOENT). Cached after first
 *  resolution since PATH does not change within a process lifetime. */
export function resolveJcodeBin(): string {
  if (cachedJcodeBin) {
    return cachedJcodeBin
  }
  const loginShell = process.env.SHELL?.trim() || '/bin/zsh'
  try {
    const out = execFileSync(loginShell, ['-lc', 'command -v jcode'], {
      encoding: 'utf8',
      timeout: 5000
    }).trim()
    // `command -v` can return multiple lines for shell functions/aliases; take
    // the first absolute path it reports.
    const candidate = out
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.startsWith('/'))
    if (candidate && existsSync(candidate)) {
      cachedJcodeBin = candidate
      return cachedJcodeBin
    }
  } catch {
    // Login shell unavailable or jcode not on PATH — fall through to fallback.
  }
  cachedJcodeBin = existsSync(JCODE_BIN_FALLBACK) ? JCODE_BIN_FALLBACK : 'jcode'
  return cachedJcodeBin
}
