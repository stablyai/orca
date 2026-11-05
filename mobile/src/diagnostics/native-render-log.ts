import { sanitizeCrashReportString } from '../../../src/shared/crash-report-redaction'
import { captureBridgeError } from '../mobile-web-shell/bridge/bridge-error-capture'
import { connectionLogStore } from '../transport/persisted-connection-log-store'

export const NATIVE_APP_LOG_ID = 'orca:native-app'
let sequence = 0

export function recordNativeRenderError(error: unknown, route: string): void {
  const ts = Date.now()
  const category = captureBridgeError(error).category
  let frames = ''
  try {
    if (error instanceof Error && typeof error.stack === 'string') {
      // Only frames: multiline error messages can contain user content.
      const prefix = `${error.name}: ${error.message}`
      frames = (error.stack.startsWith(prefix) ? error.stack.slice(prefix.length) : '')
        .split(/\r?\n/)
        .filter((line) => /^\s+at /.test(line))
        .join('\n')
    }
  } catch {
    // A thrown value can have an unreadable stack getter.
  }
  connectionLogStore.append(NATIVE_APP_LOG_ID, {
    id: `native-render-${ts}-${++sequence}`,
    ts,
    level: 'error',
    code: 'native-render-failed',
    message: 'Native screen failed to render',
    detail: sanitizeCrashReportString(`/${route || 'index'}: ${category}\n${frames}`, 2_000)
  })
}
