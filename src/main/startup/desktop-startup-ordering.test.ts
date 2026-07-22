import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('startup ordering', () => {
  it('passes the startup barrier into PTY handlers without blocking window creation', () => {
    const source = readFileSync(join(process.cwd(), 'src/main/index.ts'), 'utf8')
    const attachStart = source.indexOf('attachMainWindowServices(')
    const attachEnd = source.indexOf('rateLimits.attach(window)', attachStart)
    const attachBlock = source.slice(attachStart, attachEnd)
    const desktopStart = source.indexOf('const [win] = await Promise.all([')
    const desktopEnd = source.indexOf('// Why: the macOS notification permission dialog')
    const desktopStartup = source.slice(desktopStart, desktopEnd)

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
    expect(desktopWindowStart).toBeGreaterThan(reconciliationStart)
    expect(serveStartup).toContain('await managedWslCliStartupBarrierReady')
    expect(serveStartup).not.toContain('await managedWslCliReconciliationReady')
    expect(serveStartup.indexOf('await managedWslCliStartupBarrierReady')).toBeLessThan(
      serveStartup.indexOf('await runtimeRpc.start()')
    )
    expect(desktopStartup).not.toContain('await managedWslCliReconciliationReady')
    expect(barrier).toContain('managedWslCliStartupBarrierReady')
    expect(barrier).not.toContain('managedWslCliReconciliationReady')
  })

  it('exposes managed WSL reconciliation status to headless serve clients and diagnostics', () => {
    const source = readFileSync(join(process.cwd(), 'src/main/index.ts'), 'utf8')

    // Why: the barrier fails open, so the serve-ready payload must carry the
    // reconciliation state and the bounded wait must be traceable via a milestone.
    const readyStart = source.indexOf('await serveReadinessPublisher.publish(')
    const readyEnd = source.indexOf('pairing: pairing.available', readyStart)
    const readyPayload = source.slice(readyStart, readyEnd)
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
