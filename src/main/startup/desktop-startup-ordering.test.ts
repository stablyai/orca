import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('startup ordering', () => {
  it('passes the startup barrier into PTY handlers without blocking window creation', () => {
    const attachSource = readFileSync(
      join(process.cwd(), 'src/main/window/attach-main-window-services.ts'),
      'utf8'
    )
    const startupSource = readFileSync(
      join(process.cwd(), 'src/main/startup/main-process-pty-startup.ts'),
      'utf8'
    )
    const coreSource = readFileSync(
      join(process.cwd(), 'src/main/startup/main-window-core-services.ts'),
      'utf8'
    )
    const runtimeLaunchSource = readFileSync(
      join(process.cwd(), 'src/main/startup/main-process-runtime-launch.ts'),
      'utf8'
    )
    const attachStart = attachSource.indexOf('export function attachMainWindowServices(')
    const attachEnd = attachSource.indexOf('  registerSshHandlers(', attachStart)
    const attachBlock = attachSource.slice(attachStart, attachEnd)
    // Why: anchor on the destructure head only — the settled-result variable's name is not the
    // contract, and pinning it turns a rename into a cryptic `expected -1` failure here.
    const desktopStart = runtimeLaunchSource.indexOf('async function launchDesktopMode(')
    // Why: anchor on code, not a comment — the previous comment anchor was silently reworded, so
    // this was -1 and sliced to EOF, letting the assertions below pass against never-run code.
    const desktopEnd = runtimeLaunchSource.indexOf(
      '\nexport async function initializeMainProcessRuntimeLaunch',
      desktopStart
    )
    const desktopStartup = runtimeLaunchSource.slice(desktopStart, desktopEnd)

    // Why: bound every anchor, not just the desktop pair — an unresolved one slices to EOF.
    expect(attachStart).toBeGreaterThanOrEqual(0)
    expect(attachEnd).toBeGreaterThan(attachStart)
    expect(desktopStart).toBeGreaterThanOrEqual(0)
    expect(desktopEnd).toBeGreaterThan(desktopStart)

    expect(coreSource).toContain('awaitLocalPtyStartup: () => state.localPtyStartupReady')
    expect(coreSource).toContain(
      'awaitLocalPtyProviderStartup: () => state.localPtyProviderStartupReady'
    )
    expect(attachBlock).toContain('awaitLocalPtyStartup: options?.awaitLocalPtyStartup')
    expect(attachBlock).toContain(
      'awaitLocalPtyProviderStartup: options?.awaitLocalPtyProviderStartup'
    )
    expect(startupSource).toContain(
      'firstWindowStartupServicesReady = services.then((value) => value.firstWindowReady)'
    )
    expect(startupSource).toContain(
      'localPtyStartupReady = services.then((value) => value.localPtyReady)'
    )

    const windowIndex = desktopStartup.indexOf('Promise.resolve(desktopWindow ?? openMainWindow())')
    const rpcStartIndex = desktopStartup.indexOf('desktopRuntimeRpc.start()')
    const legacyRpcStartIndex = desktopStartup.indexOf('runtimeRpc.start()')

    expect(windowIndex).toBeGreaterThanOrEqual(0)
    expect(Math.max(rpcStartIndex, legacyRpcStartIndex)).toBeGreaterThanOrEqual(0)
    expect(desktopStartup).toMatch(
      /shellPathReady\s*\.then\(\(\) => (?:desktopRuntimeRpc|runtimeRpc)\.start\(\)\)/
    )
    expect(desktopStartup).toContain('recordRuntimeRpcStartFailure(')
    // Why: `void`, not `await` — awaiting the dialog would park the rest of startup behind a modal.
    expect(desktopStartup).toMatch(/void showRuntimeRpcStartupFailureDialog\(\s*win,/)
    // Why (#11025): a bare console.error here is exactly what left the CLI dead but the app healthy.
    expect(desktopStartup).not.toContain(
      "console.error('[runtime] Failed to start local RPC transport:'"
    )
  })

  it('resolves the browser hosting identity with nothing awaited before it', () => {
    const entrySource = readFileSync(join(process.cwd(), 'src/main/index.ts'), 'utf8')
    const foundationSource = readFileSync(
      join(process.cwd(), 'src/main/startup/main-process-ready-foundation.ts'),
      'utf8'
    )
    const readyIndex = entrySource.indexOf('void app.whenReady().then(async () => {')
    const initReadyIndex = entrySource.indexOf('initializeMainProcessReady({')
    const profileIndex = foundationSource.indexOf('const profile = ensureActiveOrcaProfile()')
    const initIndex = foundationSource.indexOf(
      'initializeBrowserClientHostId(profile.profileDirectory)'
    )

    expect(readyIndex).toBeGreaterThanOrEqual(0)
    expect(initReadyIndex).toBeGreaterThan(readyIndex)
    expect(profileIndex).toBeGreaterThanOrEqual(0)
    expect(initIndex).toBeGreaterThan(profileIndex)
    // Why nothing may be awaited first: the identity is stamped into the renderer's argv when the
    // window is created, and a suspension here lets a window be created against a process-local
    // stand-in that the durable id then contradicts. The constraint is positional, so only a source
    // census can hold it — no behavioural test distinguishes "resolved" from "resolved in time".
    expect(foundationSource.slice(profileIndex, initIndex)).not.toMatch(/\bawait\b/)
    // Why the count: a second call site would leave the ordering claim above ambiguous.
    expect(foundationSource.split('initializeBrowserClientHostId(')).toHaveLength(2)
  })

  it('requires daemon authority before restored-subagent liveness runs', () => {
    const source = readFileSync(
      join(process.cwd(), 'src/main/startup/main-process-pty-startup.ts'),
      'utf8'
    )
    const sweepStart = source.indexOf(
      'export async function reapRestoredSubagentsWithoutLiveAgent()'
    )
    const sweepEnd = source.indexOf(
      'export function startTerminalRuntimeStartupServices()',
      sweepStart
    )
    const sweep = source.slice(sweepStart, sweepEnd)

    expect(sweepStart).toBeGreaterThanOrEqual(0)
    expect(sweepEnd).toBeGreaterThan(sweepStart)
    expect(sweep).toContain('const provider = getDaemonProvider()')
    expect(sweep).toContain('if (!provider) {')
    expect(sweep).toContain('provider.probePtyLiveness(ptyId)')
  })

  it('bounds WSL reconciliation before serve RPC while leaving desktop startup independent', () => {
    const barrierSource = readFileSync(
      join(process.cwd(), 'src/main/startup/main-process-ipc-bootstrap.ts'),
      'utf8'
    )
    const foundationSource = readFileSync(
      join(process.cwd(), 'src/main/startup/main-process-ready-foundation.ts'),
      'utf8'
    )
    const runtimeSource = readFileSync(
      join(process.cwd(), 'src/main/startup/main-process-runtime-launch.ts'),
      'utf8'
    )
    const barrierStart = barrierSource.indexOf(
      "ipcMain.handle('app:awaitFirstWindowStartupServices'"
    )
    const barrierEnd = barrierSource.indexOf("'app:startupDiagnostic'", barrierStart)
    const barrier = barrierSource.slice(barrierStart, barrierEnd)
    const reconciliationStart = foundationSource.indexOf(
      'state.managedWslCliReconciliationReady = reconcileManagedWslCliRegistrations('
    )
    const serveStart = runtimeSource.indexOf('async function launchServeMode(')
    const serveEnd = runtimeSource.indexOf('\nasync function launchDesktopMode', serveStart)
    const serveStartup = runtimeSource.slice(serveStart, serveEnd)
    const desktopStart = runtimeSource.indexOf(
      "  if (process.platform === 'win32' && app.isPackaged && !serveOptions)"
    )
    const desktopEnd = runtimeSource.indexOf("  app.on('activate'", desktopStart)
    const desktopStartup = runtimeSource.slice(desktopStart, desktopEnd)

    expect(barrierStart).toBeGreaterThanOrEqual(0)
    expect(barrierEnd).toBeGreaterThan(barrierStart)
    expect(reconciliationStart).toBeGreaterThanOrEqual(0)
    expect(serveStart).toBeGreaterThanOrEqual(0)
    expect(serveEnd).toBeGreaterThan(serveStart)
    expect(desktopStart).toBeGreaterThanOrEqual(0)
    expect(desktopEnd).toBeGreaterThan(desktopStart)
    expect(serveStartup).toContain('await state.managedWslCliStartupBarrierReady')
    expect(serveStartup).not.toContain('await state.managedWslCliReconciliationReady')
    expect(serveStartup.indexOf('await state.managedWslCliStartupBarrierReady')).toBeLessThan(
      serveStartup.indexOf('await runtimeRpc.start()')
    )
    expect(desktopStartup).not.toContain('await state.managedWslCliReconciliationReady')
    expect(desktopStartup).toContain(
      "process.platform === 'win32' && app.isPackaged && !serveOptions"
    )
    expect(desktopStartup).toContain(
      'openWindow: () => options.openMainWindow({ revealOnDidFinishLoad: true })'
    )
    expect(desktopStartup).toContain('bindServices: bindTerminalRuntimeStartupServices')
    expect(desktopStartup).toContain('shellPathReady,')
    expect(desktopStartup).toContain('startServices: startTerminalRuntimeStartupServices')
    expect(barrier).toContain('managedWslCliStartupBarrierReady')
    expect(barrier).not.toContain('managedWslCliReconciliationReady')
    expect(barrier).toContain("ipcMain.handle('app:recoverLegacyWorkerTerminalsForRendererStartup'")
    expect(barrier).toContain('recoverLegacyWorkerTerminalsForRendererStartup({')
    expect(barrier).toContain('localPtyProviderStartupReady,')
    expect(barrier).toContain('await state.runtime?.refreshRestoredOrchestrationAuthority()')
    expect(barrier).toContain(
      'return state.runtime?.reconcileLegacyWorkerTerminals({ materializeRenderer: true })'
    )
  })

  it('keeps the git-environment barrier off the PTY startup services', () => {
    const barrierSource = readFileSync(
      join(process.cwd(), 'src/main/startup/main-process-ipc-bootstrap.ts'),
      'utf8'
    )
    const launchSource = readFileSync(
      join(process.cwd(), 'src/main/startup/main-process-runtime-launch.ts'),
      'utf8'
    )
    const gitBarrierStart = barrierSource.indexOf(
      "ipcMain.handle('app:awaitGitEnvironmentStartupBarrier'"
    )
    const gitBarrierEnd = barrierSource.indexOf(
      "'app:prepareTerminalStartupRestoration'",
      gitBarrierStart
    )
    expect(gitBarrierStart).toBeGreaterThanOrEqual(0)
    expect(gitBarrierEnd).toBeGreaterThan(gitBarrierStart)
    const gitBarrier = barrierSource.slice(gitBarrierStart, gitBarrierEnd)
    // The git environment fence is shell PATH + WSL registration; a daemon PTY provider or a
    // hook-server bind here puts terminal startup back in front of worktree hydration.
    expect(gitBarrier).toContain('state.shellPathReady')
    expect(gitBarrier).toContain('state.managedWslCliStartupBarrierReady')
    expect(gitBarrier).not.toContain('firstWindowStartupServicesReady')
    // The published promise must be the same one the terminal startup services wait on.
    expect(launchSource).toContain('state.shellPathReady = shellPathReady')
    expect(launchSource.indexOf('state.shellPathReady = shellPathReady')).toBeLessThan(
      launchSource.indexOf('await launchDesktopMode(')
    )
    // Terminal restoration itself must still fence on the first-window services.
    const restorationStart = barrierSource.indexOf(
      "ipcMain.handle('app:prepareTerminalStartupRestoration'"
    )
    const restorationEnd = barrierSource.indexOf(
      "'app:recoverLegacyWorkerTerminalsForRendererStartup'",
      restorationStart
    )
    expect(barrierSource.slice(restorationStart, restorationEnd)).toContain(
      'state.firstWindowStartupServicesReady'
    )
  })

  it('reconciles retained Codex homes after authoritative daemon inventory', () => {
    const source = readFileSync(
      join(process.cwd(), 'src/main/startup/main-process-pty-startup.ts'),
      'utf8'
    )
    const startupStart = source.indexOf('export function startTerminalRuntimeStartupServices()')
    expect(startupStart).toBeGreaterThanOrEqual(0)
    const startup = source.slice(startupStart)
    const daemonInitIndex = startup.indexOf('await initDaemonPtyProvider(signal')
    const retainedPaneGateIndex = startup.indexOf(
      'hasRecordedManagedHostCodexPane()',
      daemonInitIndex
    )
    const inventoryIndex = startup.indexOf('await listLiveDaemonPtyIds()', daemonInitIndex)
    const reconciliation = 'state.codexRuntimeHome?.reconcileLegacySharedHomeForRetainedPanes()'
    const reconciliationIndex = startup.indexOf(reconciliation, inventoryIndex)
    const hookReconciliationIndex = startup.indexOf(
      'reconcileRetainedCodexHookHomes({',
      inventoryIndex
    )

    expect(daemonInitIndex).toBeGreaterThanOrEqual(0)
    expect(retainedPaneGateIndex).toBeGreaterThan(daemonInitIndex)
    expect(inventoryIndex).toBeGreaterThan(daemonInitIndex)
    expect(inventoryIndex).toBeGreaterThan(retainedPaneGateIndex)
    expect(hookReconciliationIndex).toBeGreaterThan(inventoryIndex)
    expect(hookReconciliationIndex).toBeLessThan(reconciliationIndex)
    expect(reconciliationIndex).toBeGreaterThan(inventoryIndex)
    // The call is intentionally kept after the authoritative inventory; anchoring on the state
    // receiver avoids matching any prose that mentions the same operation.
    expect(startup).toContain(reconciliation)
  })

  it('exposes managed WSL reconciliation status to headless serve clients and diagnostics', () => {
    const serveSource = readFileSync(
      join(process.cwd(), 'src/main/startup/main-process-serve.ts'),
      'utf8'
    )
    const runtimeSource = readFileSync(
      join(process.cwd(), 'src/main/startup/main-process-runtime-launch.ts'),
      'utf8'
    )
    const foundationSource = readFileSync(
      join(process.cwd(), 'src/main/startup/main-process-ready-foundation.ts'),
      'utf8'
    )

    // Why: the barrier fails open, so the serve-ready payload must carry the
    // reconciliation state and the bounded wait must be traceable via a milestone.
    const readyStart = serveSource.indexOf('await state.serveReadinessPublisher.publish(')
    const readyEnd = serveSource.indexOf('pairing: pairing.available', readyStart)
    const readyPayload = serveSource.slice(readyStart, readyEnd)

    // Why: unbounded, a renamed pairing key slices to EOF and the status only has to survive
    // somewhere later in the file — not in the serve-ready payload this test is about.
    expect(readyStart).toBeGreaterThanOrEqual(0)
    expect(readyEnd).toBeGreaterThan(readyStart)
    expect(readyPayload).toContain(
      'managedWslCliReconciliation: state.managedWslCliReconciliationStatus'
    )

    expect(foundationSource).toContain("state.managedWslCliReconciliationStatus = 'pending'")
    expect(foundationSource).toContain("state.managedWslCliReconciliationStatus = 'settled'")
    expect(foundationSource).toContain("state.managedWslCliReconciliationStatus = 'failed'")
    expect(runtimeSource).toContain("logStartupMilestone('wsl-cli-barrier-resolved'")
  })

  it('notifies the serve supervisor only after publishing readiness', () => {
    const source = readFileSync(
      join(process.cwd(), 'src/main/startup/main-process-serve.ts'),
      'utf8'
    )
    const readyStart = source.indexOf('await state.serveReadinessPublisher.publish(')
    const supervisorReady = source.indexOf('notifyServeSupervisorReady(', readyStart)

    expect(readyStart).toBeGreaterThanOrEqual(0)
    expect(supervisorReady).toBeGreaterThan(readyStart)
  })

  it('does not run the rate-limit quota fetch before the first window can show results', () => {
    const source = readFileSync(
      join(process.cwd(), 'src/main/startup/main-window-core-services.ts'),
      'utf8'
    )
    const attachIndex = source.indexOf('rateLimits.attach(window)')
    const startIndex = source.indexOf('rateLimits.start({ fetchImmediately: false })')

    expect(attachIndex).toBeGreaterThanOrEqual(0)
    expect(startIndex).toBeGreaterThan(attachIndex)
  })

  it('wires bounded teardown state to reporting but not recovery or close behavior', () => {
    const lifecycleSource = readFileSync(
      join(process.cwd(), 'src/main/startup/main-window-lifecycle-flags.ts'),
      'utf8'
    )
    const windowSource = readFileSync(
      join(process.cwd(), 'src/main/startup/main-window-controller.ts'),
      'utf8'
    )

    expect(lifecycleSource).toContain('export function getExpectedTeardownScope(')
    expect(lifecycleSource).toContain('resolveExpectedTeardownScope({')
    expect(lifecycleSource).toContain('includeSystemSessionEnd')
    expect(windowSource).toContain('const window = createMainWindow(store, {')
    expect(windowSource).toContain('getIsQuitting: () => state.isQuitting')
    expect(windowSource).toContain(
      'expectedTeardown: getExpectedTeardownScope(webContentsId, false)'
    )
    expect(lifecycleSource).toContain('expectedTeardown: getExpectedTeardownScope(webContentsId)')
  })

  it('attaches renderer services before starting the TCC prompt watcher', () => {
    const coreSource = readFileSync(
      join(process.cwd(), 'src/main/startup/main-window-core-services.ts'),
      'utf8'
    )
    const windowSource = readFileSync(
      join(process.cwd(), 'src/main/startup/main-window-controller.ts'),
      'utf8'
    )
    const quitSource = readFileSync(
      join(process.cwd(), 'src/main/startup/main-process-quit.ts'),
      'utf8'
    )
    const attachIndex = coreSource.indexOf('attachMainWindowServices(')
    const tccNoticeIndex = coreSource.indexOf('initTccPromptNotice(window', attachIndex)
    const quitAbortStart = windowSource.indexOf('onQuitAborted:')
    const quitAbortEnd = windowSource.indexOf('onRendererProcessGone:', quitAbortStart)

    expect(attachIndex).toBeGreaterThanOrEqual(0)
    expect(tccNoticeIndex).toBeGreaterThan(attachIndex)
    expect(coreSource.slice(tccNoticeIndex, tccNoticeIndex + 120)).toContain(
      'deferWatchUntilReadyToShow: true'
    )
    expect(windowSource.slice(quitAbortStart, quitAbortEnd)).not.toContain('initTccPromptNotice')
    expect(quitSource).toContain("process.once('exit', stopTccPromptNotice)")
    const willQuitStart = quitSource.indexOf("app.on('will-quit'")
    expect(quitSource.slice(willQuitStart)).toContain('stopTccPromptNotice()')
    expect(quitSource).not.toContain('stopTccPromptNoticeForQuit')
  })

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
    expect(beforeQuit).not.toContain('unsubscribeSystemResumeBroadcast')
    expect(commitIndex).toBeGreaterThanOrEqual(0)
    expect(disposeIndex).toBeGreaterThan(commitIndex)
  })

  it('joins structured agent sessions to the committed quit barrier', () => {
    const source = readFileSync(
      join(process.cwd(), 'src/main/startup/main-process-quit.ts'),
      'utf8'
    )
    const willQuitStart = source.indexOf("app.on('will-quit'")
    const willQuitEnd = source.indexOf("app.on('window-all-closed'", willQuitStart)
    const willQuit = source.slice(willQuitStart, willQuitEnd)

    expect(willQuit).toContain(
      'const structuredAgentSessionShutdown = stopStructuredAgentSessionRuntime()'
    )
    expect(willQuit).toContain(
      "{ name: 'structured-agent-session', promise: structuredAgentSessionShutdown }"
    )
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

  it('starts the automation scheduler before headless serve reports ready', () => {
    const source = readFileSync(
      join(process.cwd(), 'src/main/startup/main-process-runtime-launch.ts'),
      'utf8'
    )
    const windowSource = readFileSync(
      join(process.cwd(), 'src/main/startup/main-window-core-services.ts'),
      'utf8'
    )
    const serveStart = source.indexOf('async function launchServeMode(')
    const serveReady = source.indexOf('await printServeReady(serveOptions)', serveStart)
    const serveEnd = source.indexOf('\nasync function launchDesktopMode', serveStart)
    const runtimeRpcStart = source.indexOf('await runtimeRpc.start()', serveStart)
    const automationStart = source.indexOf('state.automations?.start()', serveStart)
    const desktopSetWebContents = windowSource.indexOf(
      'automations.setWebContents(window.webContents)'
    )
    const desktopAutomationStart = windowSource.indexOf(
      'automations.start()',
      desktopSetWebContents + 1
    )

    expect(serveStart).toBeGreaterThanOrEqual(0)
    expect(serveReady).toBeGreaterThan(serveStart)
    expect(serveEnd).toBeGreaterThan(serveReady)
    expect(runtimeRpcStart).toBeGreaterThan(serveStart)
    expect(automationStart).toBeGreaterThan(runtimeRpcStart)
    expect(automationStart).toBeLessThan(serveReady)
    expect(automationStart).toBeLessThan(serveEnd)
    expect(desktopSetWebContents).toBeGreaterThanOrEqual(0)
    expect(desktopAutomationStart).toBeGreaterThan(desktopSetWebContents)
  })

  it('installs the serve supervisor disconnect quit after the app environment and data path', () => {
    // Why (#16761): the call resolves the handoff path through getCanonicalUserDataPath(). At module
    // scope that accessor throws by design, so every `orca serve` process on macOS died at startup
    // before it could listen. serve-update-handoff.test.ts mocks the resolver, so only ordering
    // catches this; serve-update-handoff.app-environment.test.ts pins the throw it depends on.
    const source = readFileSync(
      join(process.cwd(), 'src/main/startup/main-process-preflight.ts'),
      'utf8'
    )
    const install = 'installServeSupervisorDisconnectQuit(state.isServeMode)'
    const appEnvironmentIndex = source.indexOf('setAppEnvironment(new ElectronAppEnvironment())')
    const dataPathIndex = source.indexOf('initDataPath()')
    const installIndex = source.indexOf(install)
    // Why this anchor: preflight returns early when the lock is lost, so this gate is the split's
    // equivalent of the old `if (hasSingleInstanceLock)` block head.
    const lockGateIndex = source.indexOf('if (!hasLock) {')

    expect(source.split(install).length - 1, `${install} should appear exactly once`).toBe(1)
    expect(appEnvironmentIndex).toBeGreaterThanOrEqual(0)
    expect(dataPathIndex).toBeGreaterThan(appEnvironmentIndex)
    expect(installIndex).toBeGreaterThan(dataPathIndex)
    expect(lockGateIndex).toBeGreaterThanOrEqual(0)
    expect(installIndex).toBeGreaterThan(lockGateIndex)

    // Why also pin it synchronous: 'disconnect' cannot be delivered while preflight is still
    // running, which is the whole reason deferring it is free. Parked behind an await — say
    // inside app.whenReady() — the ordering above still holds but a parent that dies in the gap
    // leaves the serve process orphaned on its port, which is the failure this handler prevents.
    expect(source).toContain('export function runMainProcessPreflight(')
    // Why only statements at block indentation: the span covers unrelated helper bodies, and an
    // `await` inside one of those is not what this guards against — the risk is this call itself
    // being parked behind one.
    const blockStatements = source
      .slice(lockGateIndex, installIndex)
      .split('\n')
      .filter((line) => /^ {2}\S/.test(line) && !line.trim().startsWith('//'))
      .join('\n')
    expect(blockStatements).not.toContain('await')
  })
})
