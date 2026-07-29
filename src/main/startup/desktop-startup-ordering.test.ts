import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('startup ordering', () => {
  it('passes the startup barrier into PTY handlers without blocking window creation', () => {
    const source = readFileSync(join(process.cwd(), 'src/main/index.ts'), 'utf8')
    const attachStart = source.indexOf('attachMainWindowServices(')
    const attachEnd = source.indexOf('rateLimits.attach(window)', attachStart)
    const attachBlock = source.slice(attachStart, attachEnd)
    // Why: anchor on the destructure head only — the settled-result variable's name is not the
    // contract, and pinning it turns a rename into a cryptic `expected -1` failure here.
    const desktopStart = source.indexOf('const [win')
    // Why: anchor on code, not a comment — the previous comment anchor was silently reworded, so
    // this was -1 and sliced to EOF, letting the assertions below pass against never-run code.
    const desktopEnd = source.indexOf("win.once('show'", desktopStart)
    const desktopStartup = source.slice(desktopStart, desktopEnd)

    // Why: bound every anchor, not just the desktop pair — an unresolved one slices to EOF.
    expect(attachStart).toBeGreaterThanOrEqual(0)
    expect(attachEnd).toBeGreaterThan(attachStart)
    expect(desktopStart).toBeGreaterThanOrEqual(0)
    expect(desktopEnd).toBeGreaterThan(desktopStart)

    expect(attachBlock).toContain('awaitLocalPtyStartup: () => localPtyStartupReady')
    expect(attachBlock).toContain(
      'awaitLocalPtyProviderStartup: () => localPtyProviderStartupReady'
    )
    expect(source).toContain('firstWindowStartupServicesReady = startupServices.firstWindowReady')
    expect(source).toContain('localPtyStartupReady = startupServices.localPtyReady')

    const windowIndex = desktopStartup.indexOf('Promise.resolve(openMainWindow())')
    const rpcStartIndex = desktopStartup.indexOf('desktopRuntimeRpc.start()')
    const legacyRpcStartIndex = desktopStartup.indexOf('runtimeRpc.start()')

    expect(windowIndex).toBeGreaterThanOrEqual(0)
    expect(Math.max(rpcStartIndex, legacyRpcStartIndex)).toBeGreaterThanOrEqual(0)
    expect(desktopStartup).toContain('recordRuntimeRpcStartFailure(')
    // Why: `void`, not `await` — awaiting the dialog would park the rest of startup behind a modal.
    expect(desktopStartup).toMatch(/void showRuntimeRpcStartupFailureDialog\(\s*win,/)
    // Why (#11025): a bare console.error here is exactly what left the CLI dead but the app healthy.
    expect(desktopStartup).not.toContain(
      "console.error('[runtime] Failed to start local RPC transport:'"
    )
  })

  it('bounds WSL reconciliation before serve RPC while leaving desktop startup independent', () => {
    const source = readFileSync(join(process.cwd(), 'src/main/index.ts'), 'utf8')
    const barrierStart = source.indexOf("ipcMain.handle('app:awaitFirstWindowStartupServices'")
    const barrierEnd = source.indexOf("ipcMain.handle(\n  'app:startupDiagnostic'", barrierStart)
    const barrier = source.slice(barrierStart, barrierEnd)
    const reconciliationStart = source.indexOf(
      'managedWslCliReconciliationReady = reconcileManagedWslCliRegistrations('
    )
    const serveStart = source.indexOf('if (serveOptions) {', reconciliationStart)
    const serveReady = source.indexOf('await printServeReady(serveOptions)', serveStart)
    const serveEnd = source.indexOf('return', serveReady)
    const desktopWindowStart = source.indexOf('Promise.resolve(openMainWindow())')
    const serveStartup = source.slice(serveStart, serveEnd)
    const desktopStartup = source.slice(serveEnd, desktopWindowStart)

    expect(reconciliationStart).toBeGreaterThanOrEqual(0)
    expect(serveStart).toBeGreaterThan(reconciliationStart)
    expect(serveEnd).toBeGreaterThan(serveStart)
    // Why: bound against serveEnd, not reconciliationStart — an earlier openMainWindow() call
    // would steal this anchor, collapse desktopStartup to '', and pass the negative check below.
    expect(desktopWindowStart).toBeGreaterThan(serveEnd)
    expect(serveStartup).toContain('await managedWslCliStartupBarrierReady')
    expect(serveStartup).not.toContain('await managedWslCliReconciliationReady')
    expect(serveStartup.indexOf('await managedWslCliStartupBarrierReady')).toBeLessThan(
      serveStartup.indexOf('await runtimeRpc.start()')
    )
    expect(desktopStartup).not.toContain('await managedWslCliReconciliationReady')
    expect(barrier).toContain('managedWslCliStartupBarrierReady')
    expect(barrier).not.toContain('managedWslCliReconciliationReady')
    expect(barrier).toContain("ipcMain.handle('app:recoverLegacyWorkerTerminalsForRendererStartup'")
    expect(barrier).toContain('recoverLegacyWorkerTerminalsForRendererStartup({')
    expect(barrier).toContain('localPtyProviderStartupReady,')
    expect(barrier).toContain('await runtime?.refreshRestoredOrchestrationAuthority()')
    expect(barrier).toContain(
      'return runtime?.reconcileLegacyWorkerTerminals({ materializeRenderer: true })'
    )
  })

  it('exposes managed WSL reconciliation status to headless serve clients and diagnostics', () => {
    const source = readFileSync(join(process.cwd(), 'src/main/index.ts'), 'utf8')

    // Why: the barrier fails open, so the serve-ready payload must carry the
    // reconciliation state and the bounded wait must be traceable via a milestone.
    const readyStart = source.indexOf('await serveReadinessPublisher.publish(')
    const readyEnd = source.indexOf('pairing: pairing.available', readyStart)
    const readyPayload = source.slice(readyStart, readyEnd)

    // Why: unbounded, a renamed pairing key slices to EOF and the status only has to survive
    // somewhere later in the file — not in the serve-ready payload this test is about.
    expect(readyStart).toBeGreaterThanOrEqual(0)
    expect(readyEnd).toBeGreaterThan(readyStart)
    expect(readyPayload).toContain('managedWslCliReconciliation: managedWslCliReconciliationStatus')

    expect(source).toContain("managedWslCliReconciliationStatus = 'pending'")
    expect(source).toContain("managedWslCliReconciliationStatus = 'settled'")
    expect(source).toContain("managedWslCliReconciliationStatus = 'failed'")
    expect(source).toContain("logStartupMilestone('wsl-cli-barrier-resolved'")
  })

  it('notifies the serve supervisor only after publishing readiness', () => {
    const source = readFileSync(join(process.cwd(), 'src/main/index.ts'), 'utf8')
    const readyStart = source.indexOf('await serveReadinessPublisher.publish(')
    const supervisorReady = source.indexOf('notifyServeSupervisorReady(', readyStart)

    expect(readyStart).toBeGreaterThanOrEqual(0)
    expect(supervisorReady).toBeGreaterThan(readyStart)
  })

  it('does not run the rate-limit quota fetch before the first window can show results', () => {
    const source = readFileSync(join(process.cwd(), 'src/main/index.ts'), 'utf8')
    const attachIndex = source.indexOf('rateLimits.attach(window)')
    const startIndex = source.indexOf('rateLimits.start({ fetchImmediately: false })')

    expect(attachIndex).toBeGreaterThanOrEqual(0)
    expect(startIndex).toBeGreaterThan(attachIndex)
  })

  it('attaches renderer services before starting the TCC prompt watcher', () => {
    const source = readFileSync(join(process.cwd(), 'src/main/index.ts'), 'utf8')
    const attachIndex = source.indexOf('attachMainWindowServices(')
    const tccNoticeIndex = source.indexOf('initTccPromptNotice(window', attachIndex)
    const quitAbortStart = source.indexOf('onQuitAborted:')
    const quitAbortEnd = source.indexOf('onRendererProcessGone:', quitAbortStart)

    expect(attachIndex).toBeGreaterThanOrEqual(0)
    expect(tccNoticeIndex).toBeGreaterThan(attachIndex)
    expect(source.slice(tccNoticeIndex, tccNoticeIndex + 120)).toContain(
      'deferWatchUntilReadyToShow: true'
    )
    expect(source.slice(quitAbortStart, quitAbortEnd)).not.toContain('initTccPromptNotice')
    expect(source).toContain("process.once('exit', stopTccPromptNotice)")
    const willQuitStart = source.indexOf("app.on('will-quit'")
    const windowAllClosedStart = source.indexOf("app.on('window-all-closed'", willQuitStart)
    expect(source.slice(willQuitStart, windowAllClosedStart)).toContain('stopTccPromptNotice()')
    expect(source.slice(0, willQuitStart)).not.toContain('stopTccPromptNoticeForQuit')
  })

  it('starts the automation scheduler before headless serve reports ready', () => {
    const source = readFileSync(join(process.cwd(), 'src/main/index.ts'), 'utf8')
    const serveStart = source.indexOf('if (serveOptions) {')
    const serveReady = source.indexOf('await printServeReady(serveOptions)', serveStart)
    const serveReturn = source.indexOf('return', serveReady)
    const runtimeRpcStart = source.indexOf('await runtimeRpc.start()', serveStart)
    const automationStart = source.indexOf('automations.start()', serveStart)
    const desktopSetWebContents = source.indexOf('automations.setWebContents(window.webContents)')
    const desktopAutomationStart = source.indexOf('automations.start()', desktopSetWebContents + 1)

    expect(serveStart).toBeGreaterThanOrEqual(0)
    expect(serveReady).toBeGreaterThan(serveStart)
    expect(serveReturn).toBeGreaterThan(serveReady)
    expect(runtimeRpcStart).toBeGreaterThan(serveStart)
    expect(automationStart).toBeGreaterThan(runtimeRpcStart)
    expect(automationStart).toBeLessThan(serveReady)
    expect(automationStart).toBeLessThan(serveReturn)
    expect(desktopSetWebContents).toBeGreaterThanOrEqual(0)
    expect(desktopAutomationStart).toBeGreaterThan(desktopSetWebContents)
  })
})
