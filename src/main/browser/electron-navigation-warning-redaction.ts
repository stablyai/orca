import { redactKagiSessionToken } from '../../shared/browser/navigation/browser-url'

let installed = false

function redactElectronNavigationWarning(warning: Error): void {
  if (warning.name !== 'electron') {
    return
  }
  const match = /^Failed to load URL: (.*) with error: (ERR_[A-Z0-9_]+)$/.exec(warning.message)
  if (!match) {
    return
  }
  const safeUrl = redactKagiSessionToken(match[1])
  if (safeUrl === match[1]) {
    return
  }
  warning.message = `Failed to load URL: ${safeUrl} with error: ${match[2]}`
  // Node's trace-warnings printer must not retain a preformatted bearer-bearing stack.
  warning.stack = `${warning.name}: ${warning.message}`
}

export function installElectronNavigationWarningRedaction(): void {
  if (installed) {
    return
  }
  installed = true
  process.prependListener('warning', redactElectronNavigationWarning)
}
