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
    // records consent (and recovers a marker a session-end drop already took).
    expect(handler.split('writeGpuFallbackMarker(')).toHaveLength(3)
    const resolutionIndex = handler.indexOf('resolveGpuFallbackEngagement(outcome')
    expect(resolutionIndex).toBeGreaterThanOrEqual(0)
    expect(handler.lastIndexOf('writeGpuFallbackMarker(')).toBeGreaterThan(resolutionIndex)

    // Why pinned: the outcome -> bookkeeping mapping is unit-tested in
    // gpu-fallback-engagement-resolution, so re-deriving it inline here would
    // restore the zero-coverage gap this extraction closed.
    expect(handler).toContain(
      'provisionalGpuFallbackUserDataPath = resolution.provisionalMarkerPath'
    )
    expect(handler).toContain('if (resolution.rePersistConsentedMarker) {')
    expect(handler).toContain('if (!resolution.relaunch) {')
    expect(handler).not.toContain('shouldKeepProvisionalGpuFallbackMarker(')

    // Why: consent is what separates a latch the user chose from one the crash
    // imposed, and without it on disk the fix's own efficacy is unmeasurable.
    expect(handler).toContain('consented: false')
    expect(handler).toContain('consented: true')
  })

  it('counts GPU crashes across launches, not just within one', () => {
    const source = readFileSync(join(process.cwd(), 'src/main/index.ts'), 'utf8')
    const start = source.indexOf('async function handleGpuChildCrash(')
    const end = source.indexOf('function recordProcessGoneCrash(', start)
    const handler = source.slice(start, end)

    expect(start).toBeGreaterThanOrEqual(0)
    expect(end).toBeGreaterThan(start)

    // Why both: the in-process burst path is what catches a driver that fails
    // mid-session; the durable path is the only one reachable when the crash
    // kills the launch in 0.8s.
    const inProcessIndex = handler.indexOf('gpuCrashFallbackTracker.recordGpuCrash(')
    const durableIndex = handler.indexOf('evaluateGpuCrashHistory(')
    const gateIndex = handler.indexOf(
      'if (!inProcess.shouldEngageFallback && !durable.crossesThreshold) {'
    )
    const persistIndex = handler.indexOf('persistGpuCrashTimes(')
    expect(inProcessIndex).toBeGreaterThanOrEqual(0)
    expect(durableIndex).toBeGreaterThan(inProcessIndex)
    expect(gateIndex).toBeGreaterThan(durableIndex)
    // Why inside the non-firing branch: on the crash that fires, this write's fsync
    // would land in front of the marker write that is racing Chromium's kill.
    expect(persistIndex).toBeGreaterThan(gateIndex)
    expect(persistIndex).toBeLessThan(handler.indexOf('gpuFallbackEngagementStarted = true'))
    expect(handler.split('persistGpuCrashTimes(')).toHaveLength(2)

    // Why inert off Windows: the environment check must precede every write.
    const environmentIndex = handler.indexOf('getWindowsGpuFallbackEnvironment()')
    expect(environmentIndex).toBeGreaterThanOrEqual(0)
    expect(environmentIndex).toBeLessThan(inProcessIndex)
    expect(handler.indexOf('getCanonicalUserDataPath()')).toBeGreaterThan(environmentIndex)

    // Why cleared only after the prompt resolved: a kill while the modal is up must
    // leave the count armed to fire again, while a decline must not re-prompt on the
    // very next crash.
    const clearIndex = handler.indexOf('clearGpuCrashHistory(userDataPath)')
    expect(clearIndex).toBeGreaterThan(handler.indexOf('await engageGpuFallback({'))
    // Why latched: either counter can fire, so a later same-session crash would
    // otherwise stack a second modal on top of the first.
    expect(handler).toContain('gpuFallbackEngagementStarted = true')
    expect(handler).toContain('gpuFallbackEngagementStarted ||')
  })

  // Why one test over three call sites: they are the whole lifecycle of the durable
  // count, each is a one-token deletion away from silently reverting the feature to
  // the in-process tracker, and each survived the suite until this test existed.
  it('writes and clears the cross-launch GPU crash count at exactly three places', () => {
    const source = readFileSync(join(process.cwd(), 'src/main/index.ts'), 'utf8')
    const slice = (from: string, to: string): string => {
      const start = source.indexOf(from)
      const end = source.indexOf(to, start)
      expect(start).toBeGreaterThanOrEqual(0)
      expect(end).toBeGreaterThan(start)
      return source.slice(start, end)
    }

    // Why guarded: an excluded reason (`launch-failed`) evaluates to the inert
    // decision, whose crashTimes is []. Persisting that truncates the real count to
    // zero, so one excluded death silently erases the whole accumulated history.
    const handler = slice('async function handleGpuChildCrash(', 'function recordProcessGoneCrash(')
    expect(handler).toContain('const countsDurably = countsTowardDurableGpuCrashHistory(reason)')
    expect(handler).toContain(
      'if (countsDurably) {\n      persistGpuCrashTimes(userDataPath, environment, durable.crashTimes)\n    }'
    )

    // Why cleared on a safe-graphics launch: the marker is already applied, so the
    // pre-fallback times must not re-fire the prompt on the first GPU hiccup here.
    const reader = slice(
      'function maybeApplyGpuFallbackForThisLaunch()',
      'function recordGpuFallbackMarkerPersisted('
    )
    expect(reader).toContain('clearGpuCrashHistory(userDataPath)')

    // Why cleared on an orderly quit: a shutdown that reached 'quit' proves the
    // burst was survivable, so an unconfirmed marker's count must not outlive it.
    const drop = slice(
      'function dropUnconfirmedGpuFallbackMarker()',
      'function recordProcessGoneCrash('
    )
    expect(drop).toContain('clearGpuCrashHistory(provisionalGpuFallbackUserDataPath)')
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

    // Why source-wide: the marker may only be dropped by the shutdown helper, by
    // the explicit "Keep Running" answer, and by the Help-menu opt-out.
    expect(source.split('clearGpuFallbackMarker(')).toHaveLength(4)
    expect(source).toContain('function turnOffGpuFallback()')
  })

  // Why source-level: the listener is a closure inside the async init body, so the
  // only alternative is booting Electron behind a fake `app`.
  it('counts a GPU death whose breadcrumb was suppressed', () => {
    const source = readFileSync(join(process.cwd(), 'src/main/index.ts'), 'utf8')
    const start = source.indexOf("app.on('child-process-gone'")
    const end = source.indexOf("logStartupMilestone('services-initialized')", start)
    const listener = source.slice(start, end)

    expect(start).toBeGreaterThanOrEqual(0)
    expect(end).toBeGreaterThan(start)

    // Why siblings: `recordProcessGoneCrash` drops repeats on a 30s key, and that
    // suppression is a `return` inside the recorder. Nesting the GPU handler under it
    // — or making the recorder's result gate it — would hand the durable counter the
    // deduped stream, and a crash loop repeats the same reason by definition.
    expect(listener).toContain("recordProcessGoneCrash('child'")
    expect(listener).toContain('    })\n    if (\n      isGpuFallbackCrashCandidate({')
    const guardIndex = listener.indexOf('isGpuFallbackCrashCandidate({')
    const handlerIndex = listener.indexOf('void handleGpuChildCrash(')
    expect(guardIndex).toBeGreaterThan(listener.indexOf("recordProcessGoneCrash('child'"))
    expect(handlerIndex).toBeGreaterThan(guardIndex)
  })

  it('gives a latched user a way out that does not come straight back', () => {
    const source = readFileSync(join(process.cwd(), 'src/main/index.ts'), 'utf8')
    const start = source.indexOf('function turnOffGpuFallback()')
    const end = source.indexOf('function dropUnconfirmedGpuFallbackMarker()', start)
    const optOut = source.slice(start, end)

    expect(start).toBeGreaterThanOrEqual(0)
    expect(end).toBeGreaterThan(start)

    // Why both: the marker latches the next launch and the count would re-latch the
    // one after it, so clearing only one of them leaves the user still stuck.
    expect(optOut).toContain('clearGpuCrashHistory(userDataPath)')
    expect(optOut).toContain('clearGpuFallbackMarker(userDataPath)')
    // Why gated on the clear: relaunching over a marker still on disk returns the
    // user straight to safe graphics, having promised otherwise.
    const clearIndex = optOut.indexOf('if (!clearGpuFallbackMarker(userDataPath)) {')
    const relaunchIndex = optOut.indexOf("relaunchApp('gpu-fallback-opt-out'")
    expect(clearIndex).toBeGreaterThanOrEqual(0)
    expect(relaunchIndex).toBeGreaterThan(clearIndex)
    // Why canonical: a split path would clear a marker the next launch never reads.
    expect(optOut).toContain('getCanonicalUserDataPath()')

    // Why surfaced only while latched: the menu item is meaningless otherwise.
    expect(source).toContain('isGpuFallbackActive: () => gpuFallbackActiveThisLaunch')
    expect(source).toContain('onTurnOffGpuFallback: turnOffGpuFallback')
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
    // Why here: a kill between a write and its rename orphans a temp file, and
    // this is the only launch-time site that reclaims them.
    const reader = source.slice(readerStart, readerEnd)
    expect(reader).toContain('sweepStaleGpuFallbackMarkerTempFiles(userDataPath)')
    expect(reader).toContain('sweepStaleGpuCrashHistoryTempFiles(userDataPath)')
    // Why gated: the sweep readdirs all of userData (Cache / GPUCache / Local
    // Storage) on a pre-whenReady path that runs on every Windows launch.
    expect(reader).toContain('if (sweepForOrphans) {')
    expect(reader).toContain('gpuFallbackMarkerFileExists(userDataPath)')
    expect(reader).toContain('gpuCrashHistoryFileExists(userDataPath)')
    // Why on the no-marker branch: a launch that latched clears the history outright,
    // and without this the gate above stays armed for the life of the install.
    expect(reader).toContain('void discardExpiredGpuCrashHistory(userDataPath, environment, {')
    expect(reader.indexOf('discardExpiredGpuCrashHistory')).toBeGreaterThan(
      reader.indexOf('if (!marker) {')
    )
    // Why platform-gated: safe graphics is a Windows-only remedy, and
    // enableMainProcessGpuFeatures() carries the macOS Graphite fix it skips.
    expect(reader).toContain("process.platform !== 'win32'")
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
