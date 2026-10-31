import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { runProcessSync } from '@orca/process-host'
import { ELECTRON_NO_SANDBOX_REQUEST_ENV } from '../../shared/electron-no-sandbox-request'

const USER_NAMESPACE_PROBE_TIMEOUT_MS = 2_000

export function needsElectronNoSandbox(executable: string): boolean {
  return (
    process.env[ELECTRON_NO_SANDBOX_REQUEST_ENV] === '1' ||
    shouldDisableExtractedAppImageSandbox(executable)
  )
}

function shouldDisableExtractedAppImageSandbox(executable: string): boolean {
  if (process.platform !== 'linux' || !existsSync(join(dirname(executable), 'AppRun'))) {
    return false
  }
  // An extracted AppImage has no root-owned setuid sandbox; mirror AppRun's userns fallback.
  if (process.getuid?.() === 0) {
    return true
  }
  try {
    return (
      runProcessSync({
        program: 'unshare',
        args: ['-Ur', 'true'],
        stdio: 'ignore',
        timeoutMs: USER_NAMESPACE_PROBE_TIMEOUT_MS
      }).code !== 0
    )
  } catch {
    return true
  }
}
