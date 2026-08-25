import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('workspace path launch wiring', () => {
  const mainSource = readFileSync(join(process.cwd(), 'src/main/index.ts'), 'utf8')

  it('captures launch argv once at module scope, after serve-mode normalization', () => {
    const normalizeIndex = mainSource.indexOf('normalizeServeModeArgv(process.argv)')
    const captureIndex = mainSource.indexOf('openWorkspacePathFromArgv(process.argv)')
    expect(normalizeIndex).toBeGreaterThanOrEqual(0)
    expect(captureIndex).toBeGreaterThan(normalizeIndex)
  })

  it('routes second-instance argv through the same path extraction before activation gating', () => {
    const requestSource = mainSource.indexOf('function requestDesktopActivation(')
    const captureIndex = mainSource.indexOf('openWorkspacePathFromArgv(argv)', requestSource)
    const gateIndex = mainSource.indexOf(
      'if (!shouldActivateDesktopForSecondInstance(argv))',
      requestSource
    )
    expect(captureIndex).toBeGreaterThan(requestSource)
    expect(gateIndex).toBeGreaterThan(captureIndex)
  })

  it('delivers to a fully loaded renderer first and queues while the window is still loading', () => {
    const deliverIndex = mainSource.indexOf("mainWindow.webContents.send('ui:openWorkspacePath'")
    const isLoadingGuardIndex = mainSource.indexOf(
      '!mainWindow.webContents.isLoading()',
      mainSource.indexOf('function deliverWorkspacePathLaunch(')
    )
    const queueIndex = mainSource.indexOf('workspacePathLaunchQueue.queue(folderPath)')
    expect(deliverIndex).toBeGreaterThan(-1)
    expect(isLoadingGuardIndex).toBeGreaterThan(-1)
    expect(isLoadingGuardIndex).toBeLessThan(deliverIndex)
    expect(queueIndex).toBeGreaterThan(deliverIndex)
  })

  it('exposes a drain endpoint for intents queued before the renderer mounted', () => {
    expect(mainSource).toContain("'ui:consumePendingWorkspacePathLaunches'")
  })

  it('accepts Finder/Dock folder opens through the open-file event', () => {
    expect(mainSource).toContain("app.on('open-file'")
  })

  it('registers the launched-path bridge alongside the other lifetime bridges', () => {
    const bridgeSource = readFileSync(
      join(process.cwd(), 'src/renderer/src/hooks/ipc-events/app-lifetime-ipc-bridge.ts'),
      'utf8'
    )
    const sidebarBridgeIndex = bridgeSource.indexOf('registerSettingsAndSidebarIpcBridge(unsubs)')
    const launchedBridgeIndex = bridgeSource.indexOf(
      'registerLaunchedWorkspacePathIpcBridge(unsubs)'
    )
    expect(sidebarBridgeIndex).toBeGreaterThan(-1)
    expect(launchedBridgeIndex).toBeGreaterThan(sidebarBridgeIndex)
  })
})
