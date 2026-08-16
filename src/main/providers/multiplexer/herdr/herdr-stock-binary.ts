import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'

/** Resolve a stock herdr binary for live tests: explicit env, then PATH. */
export function resolveStockHerdrTestBinary(): string | null {
  const explicit = process.env.ORCA_HERDR_TEST_BINARY?.trim()
  if (explicit && existsSync(explicit)) {
    return explicit
  }
  try {
    const found = execFileSync(process.platform === 'win32' ? 'where' : 'which', ['herdr'], {
      encoding: 'utf8'
    })
      .trim()
      .split(/\r?\n/)[0]
    return found && existsSync(found) ? found : null
  } catch {
    return null
  }
}
