import { existsSync } from 'node:fs'
import { runProcess } from '../../shared/child-process/run-process'
import { windowsSystem32Binary } from '../../shared/child-process/windows-system-binary'

const SHORT_PATH_TIMEOUT_MS = 5_000

/**
 * The 8.3 spelling of an existing file (`C:\Users\JOHNSM~1\...`), or null when
 * the volume keeps no short names or the lookup fails. Node has no binding for
 * GetShortPathNameW, so this asks cmd.exe's `%~s` modifier once; the line holds
 * only the path, never free text. A path holding `%` or `"` is refused rather
 * than spelled for cmd.
 */
export async function resolveWindowsShortPath(path: string): Promise<string | null> {
  if (process.platform !== 'win32' || windowsShortPathRefuses(path) || !existsSync(path)) {
    return null
  }
  try {
    const result = await runProcess({
      program: windowsSystem32Binary('cmd.exe'),
      args: ['/d', '/c', `for %I in ("${path}") do @echo %~sI`],
      // Why verbatim: the `for` line is cmd syntax, not argv; CRT quoting would escape its quotes.
      windowsVerbatimArguments: true,
      timeoutMs: SHORT_PATH_TIMEOUT_MS
    })
    const shortPath = result.code === 0 ? result.stdout.trim() : ''
    return shortPath && !shortPath.includes('\n') && existsSync(shortPath) ? shortPath : null
  } catch {
    return null
  }
}

/** Whether the lookup refuses `path` outright: cmd.exe would read its `%` or `"` as syntax. */
export function windowsShortPathRefuses(path: string): boolean {
  return /[%"]/.test(path)
}
