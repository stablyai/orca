import { existsSync } from 'fs'
import { win32 as pathWin32 } from 'path'

export function resolveTarExecutable(
  options: {
    platform?: NodeJS.Platform
    env?: NodeJS.ProcessEnv
    exists?: (path: string) => boolean
  } = {}
): string {
  const platform = options.platform ?? process.platform
  if (platform !== 'win32') {
    return 'tar'
  }

  const env = options.env ?? process.env
  const systemRoot = env.SystemRoot ?? env.WINDIR ?? 'C:\\Windows'
  const candidate = pathWin32.join(systemRoot, 'System32', 'tar.exe')
  const exists = options.exists ?? existsSync
  if (exists(candidate)) {
    return candidate
  }

  // Why: packaged Windows apps can have a stripped PATH. Use the OS tar
  // location explicitly, and fail with a repairable error if it is absent.
  throw new Error(`Windows tar.exe not found at ${candidate}`)
}
