import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { installElectronNavigationWarningRedaction } from './electron-navigation-warning-redaction'

// Electron reports a failed main-frame load through process.emitWarning with this name and text.
function electronLoadWarning(url: string): Error {
  const warning = new Error(`Failed to load URL: ${url} with error: ERR_BLOCKED_BY_CLIENT`)
  warning.name = 'electron'
  warning.stack = `${warning.name}: ${warning.message}\n    at WebContents.loadURL (node:electron)`
  return warning
}

describe('installElectronNavigationWarningRedaction', () => {
  let installedListeners: ((warning: Error) => void)[] = []

  beforeAll(() => {
    const before = new Set(process.listeners('warning'))
    installElectronNavigationWarningRedaction()
    installElectronNavigationWarningRedaction()
    installedListeners = process.listeners('warning').filter((listener) => !before.has(listener))
  })

  afterAll(() => {
    for (const listener of installedListeners) {
      process.off('warning', listener)
    }
  })

  // Call it directly so the default printer does not echo fixture warnings into the test log.
  const redact = (warning: Error): void => installedListeners[0]?.(warning)

  it('registers one listener ahead of the default printer', () => {
    expect(installedListeners).toHaveLength(1)
    expect(process.listeners('warning')[0]).toBe(installedListeners[0])
  })

  it('removes a Kagi session token from the warning text and its trace', () => {
    const warning = electronLoadWarning('https://kagi.com/search?q=one&token=synthetic-secret')
    redact(warning)
    expect(`${warning.message}\n${warning.stack}`).not.toContain('synthetic-secret')
    expect(warning.message).toBe(
      'Failed to load URL: https://kagi.com/search?q=one with error: ERR_BLOCKED_BY_CLIENT'
    )
    expect(warning.stack).toBe(`electron: ${warning.message}`)
  })

  it('leaves other diagnostics untouched', () => {
    const ordinary = electronLoadWarning('https://example.com/control?token=ordinary-control')
    const ordinaryStack = ordinary.stack
    const unrelated = new Error(
      'Failed to load URL: https://kagi.com/?token=other with error: ERR_FAILED'
    )
    unrelated.name = 'TestControl'
    const unrelatedStack = unrelated.stack
    redact(ordinary)
    redact(unrelated)
    expect(ordinary.stack).toBe(ordinaryStack)
    expect(ordinary.message).toContain('token=ordinary-control')
    expect(unrelated.stack).toBe(unrelatedStack)
  })
})
