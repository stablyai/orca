import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('startup ordering', () => {
  it('keeps the power bridge through vetoable before-quit and disposes after commit', () => {
    const source = readFileSync(
      join(process.cwd(), 'src/main/startup/main-process-quit.ts'),
      'utf8'
    )
    const beforeQuitStart = source.indexOf("app.on('before-quit'")
    const willQuitStart = source.indexOf("app.on('will-quit'", beforeQuitStart)
    const windowAllClosedStart = source.indexOf("app.on('window-all-closed'", willQuitStart)
    const beforeQuit = source.slice(beforeQuitStart, willQuitStart)
    const willQuit = source.slice(willQuitStart, windowAllClosedStart)
    const commitIndex = willQuit.indexOf('quitTeardownStartGate.tryStart(event)')
    const disposeIndex = willQuit.indexOf('unsubscribeSystemResumeBroadcast?.()')

    expect(beforeQuitStart).toBeGreaterThanOrEqual(0)
    expect(willQuitStart).toBeGreaterThan(beforeQuitStart)
    expect(windowAllClosedStart).toBeGreaterThan(willQuitStart)
    expect(beforeQuit.indexOf('event.defaultPrevented')).toBeGreaterThanOrEqual(0)
    expect(beforeQuit.indexOf('event.defaultPrevented')).toBeLessThan(
      beforeQuit.indexOf('state.isQuitting = true')
    )
    expect(beforeQuit).not.toContain('unsubscribeSystemResumeBroadcast')
    expect(commitIndex).toBeGreaterThanOrEqual(0)
    expect(disposeIndex).toBeGreaterThan(commitIndex)
  })

  it('joins agent-browser cleanup before the committed quit exits', () => {
    const source = readFileSync(
      join(process.cwd(), 'src/main/startup/main-process-quit.ts'),
      'utf8'
    )
    const willQuitStart = source.indexOf("app.on('will-quit'")
    const windowAllClosedStart = source.indexOf("app.on('window-all-closed'", willQuitStart)
    const willQuit = source.slice(willQuitStart, windowAllClosedStart)
    const cleanupStart = willQuit.indexOf('const browserShutdown')
    const offscreenCleanupStart = willQuit.indexOf(
      'runtime?.getOffscreenBrowserBackend()?.destroyAll?.()'
    )
    const residualCleanupStart = willQuit.indexOf(
      'runtime?.getAgentBrowserBridge()?.destroyAllSessions()'
    )
    const barrierStart = willQuit.indexOf('settleTeardownWithinDeadline([')

    expect(willQuitStart).toBeGreaterThanOrEqual(0)
    expect(windowAllClosedStart).toBeGreaterThan(willQuitStart)
    expect(cleanupStart).toBeGreaterThanOrEqual(0)
    expect(offscreenCleanupStart).toBeGreaterThan(cleanupStart)
    expect(residualCleanupStart).toBeGreaterThan(offscreenCleanupStart)
    expect(barrierStart).toBeGreaterThan(cleanupStart)
    expect(willQuit.slice(barrierStart)).toContain("{ name: 'browser', promise: browserShutdown }")
  })

  it('registers repeatable serve signal handling before headless startup completes', () => {
    const source = readFileSync(
      join(process.cwd(), 'src/main/startup/main-process-runtime-launch.ts'),
      'utf8'
    )
    const serveStart = source.indexOf('async function launchServeMode(')
    const signalHandlers = source.indexOf('registerServeSignalHandlers(process', serveStart)
    const serveReady = source.indexOf('await printServeReady(serveOptions)', serveStart)

    expect(serveStart).toBeGreaterThanOrEqual(0)
    expect(signalHandlers).toBeGreaterThan(serveStart)
    expect(signalHandlers).toBeLessThan(serveReady)
  })
})
