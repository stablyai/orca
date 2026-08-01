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

  it('requires daemon authority before restored-subagent liveness runs', () => {
    const source = readFileSync(join(process.cwd(), 'src/main/index.ts'), 'utf8')
    const sweepStart = source.indexOf('function reapRestoredSubagentsWithoutLiveAgent()')
    const sweepEnd = source.indexOf('function startTerminalRuntimeStartupServices()', sweepStart)
    const sweep = source.slice(sweepStart, sweepEnd)

    expect(sweepStart).toBeGreaterThanOrEqual(0)
    expect(sweepEnd).toBeGreaterThan(sweepStart)
    expect(sweep).toContain('const provider = getDaemonProvider()')
    expect(sweep).toContain('if (!provider) {')
    expect(sweep).toContain('provider.probePtyLiveness(ptyId)')
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

  it('persists the GPU fallback marker in the same turn as the GPU crash event', () => {
    const source = readFileSync(join(process.cwd(), 'src/main/index.ts'), 'utf8')
    const start = source.indexOf('async function handleGpuChildCrash(')
    const end = source.indexOf('function recordProcessGoneCrash(', start)
    const handler = source.slice(start, end)
    const engageIndex = handler.indexOf('await engageGpuFallback({')
    const persistIndex = handler.indexOf('persistMarker: () => {')

    expect(start).toBeGreaterThanOrEqual(0)
    expect(end).toBeGreaterThan(start)
    expect(engageIndex).toBeGreaterThanOrEqual(0)
    expect(persistIndex).toBeGreaterThan(engageIndex)

    // Why the dispatch site too: the turn begins at child-process-gone, so an
    // await introduced there would push the write past the kill just as surely.
    const listenerStart = source.indexOf("app.on('child-process-gone'")
    const listenerEnd = source.indexOf('void handleGpuChildCrash(', listenerStart)
    expect(listenerStart).toBeGreaterThanOrEqual(0)
    expect(listenerEnd).toBeGreaterThan(listenerStart)
    const listener = source.slice(listenerStart, listenerEnd)
    expect(listener).not.toMatch(/\bawait[\s(]/)
    expect(listener).not.toContain('async (')

    // Why: Chromium fatally CHECKs the browser process on the 6th GPU failure —
    // ~7ms after the first when it cannot launch. Any await before the marker
    // write pushes it past that kill and restores the cross-launch crash loop.
    expect(handler.slice(0, engageIndex)).not.toMatch(/\bawait[\s(]/)

    // Why: pin the write inside persistMarker — asserting only that the source
    // mentions writeGpuFallbackMarker lets it drift into a later callback.
    // Why bound on the next dep key, not the next `},` — the write's own object
    // literal closes with `},` and would truncate the body being asserted.
    const persistEnd = handler.indexOf('clearMarker:', persistIndex)
    expect(persistEnd).toBeGreaterThan(persistIndex)
    const persistBody = handler.slice(persistIndex, persistEnd)
    expect(persistBody).toContain('writeGpuFallbackMarker(')
    expect(persistBody).toContain('provisionalGpuFallbackUserDataPath = userDataPath')
    // Why: an await inside persistMarker defers the write past the kill just as
    // surely as one before the call. (An `async` callback fails the anchor above.)
    expect(persistBody).not.toMatch(/\bawait[\s(]/)

    // Why exactly two writers: the pre-prompt persist, plus the re-persist that
    // recovers a consented restart whose marker a session-end drop already took.
    expect(handler.split('writeGpuFallbackMarker(')).toHaveLength(3)
    const confirmedQuittingIndex = handler.indexOf("outcome === 'confirmed-quitting'")
    expect(confirmedQuittingIndex).toBeGreaterThanOrEqual(0)
    expect(handler.lastIndexOf('writeGpuFallbackMarker(')).toBeGreaterThan(confirmedQuittingIndex)

    // Why pinned: the outcome -> retry mapping is unit-tested, so the handler must
    // defer to it rather than re-deriving the outcome list inline.
    expect(handler).toContain('if (!shouldKeepProvisionalGpuFallbackMarker(outcome)) {')
  })

  it('drops an unconfirmed GPU fallback marker only once the quit is committed', () => {
    const source = readFileSync(join(process.cwd(), 'src/main/index.ts'), 'utf8')
    // Why not will-quit: its first pass only means a quit was requested, then defers
    // teardown for seconds during which Chromium's GPU CHECK can still fire.
    expect(source).toContain("app.on('quit', dropUnconfirmedGpuFallbackMarker)")
    // Why session-end too: Windows logoff/shutdown is the driver-update reboot case.
    expect(source).toContain("window.on('session-end', dropUnconfirmedGpuFallbackMarker)")

    // Why bound on the NEXT listener: bounding on an early statement inside the
    // handler let a drop reintroduced further down pass unnoticed.
    const willQuitStart = source.indexOf("app.on('will-quit'")
    const willQuitEnd = source.indexOf("app.on('window-all-closed'", willQuitStart)
    expect(willQuitStart).toBeGreaterThanOrEqual(0)
    expect(willQuitEnd).toBeGreaterThan(willQuitStart)
    expect(source.slice(willQuitStart, willQuitEnd)).not.toContain(
      'dropUnconfirmedGpuFallbackMarker'
    )

    // Why source-wide: the marker may only be dropped by the shutdown helper and
    // by the explicit "Keep Running" answer.
    expect(source.split('clearGpuFallbackMarker(')).toHaveLength(3)
  })

  it('reads and writes the GPU fallback marker through the same userData path', () => {
    const source = readFileSync(join(process.cwd(), 'src/main/index.ts'), 'utf8')
    const readerStart = source.indexOf('function maybeApplyGpuFallbackForThisLaunch()')
    const readerEnd = source.indexOf('async function handleGpuChildCrash(', readerStart)
    const writerEnd = source.indexOf('function recordProcessGoneCrash(', readerEnd)

    expect(readerStart).toBeGreaterThanOrEqual(0)
    expect(readerEnd).toBeGreaterThan(readerStart)
    expect(writerEnd).toBeGreaterThan(readerEnd)

    // Why: a split between reader and writer paths turns the whole fallback into
    // a silent no-op — the marker lands somewhere the next launch never looks.
    expect(source.slice(readerStart, readerEnd)).toContain('getCanonicalUserDataPath()')
    // Why here: a kill between the marker's write and rename orphans a temp file,
    // and this is the only launch-time site that reclaims them.
    expect(source.slice(readerStart, readerEnd)).toContain(
      'sweepStaleGpuFallbackMarkerTempFiles(userDataPath)'
    )
    expect(source.slice(readerEnd, writerEnd)).toContain('getCanonicalUserDataPath()')
    expect(source.slice(readerStart, writerEnd)).not.toContain("app.getPath('userData')")
  })

  it('reconciles retained Codex homes after authoritative daemon inventory', () => {
    const source = readFileSync(join(process.cwd(), 'src/main/index.ts'), 'utf8')
    const daemonInitIndex = source.indexOf('await initDaemonPtyProvider(signal')
    const routeGateIndex = source.indexOf(
      'codexRuntimeHome?.isHostSystemDefaultRealHome()',
      daemonInitIndex
    )
    const inventoryIndex = source.indexOf('await listLiveDaemonPtyIds()', daemonInitIndex)
    const reconciliation = 'codexRuntimeHome?.reconcileLegacySharedHomeForRetainedPanes()'
    const reconciliationIndex = source.indexOf(reconciliation, inventoryIndex)
    const serveIndex = source.indexOf('if (serveOptions) {', reconciliationIndex)
    const desktopIndex = source.indexOf('Promise.resolve(openMainWindow())', serveIndex)

    expect(daemonInitIndex).toBeGreaterThanOrEqual(0)
    expect(routeGateIndex).toBeGreaterThan(daemonInitIndex)
    expect(inventoryIndex).toBeGreaterThan(routeGateIndex)
    expect(reconciliationIndex).toBeGreaterThan(inventoryIndex)
    expect(serveIndex).toBeGreaterThan(reconciliationIndex)
    expect(desktopIndex).toBeGreaterThan(serveIndex)
    expect(source.split(reconciliation)).toHaveLength(2)
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
