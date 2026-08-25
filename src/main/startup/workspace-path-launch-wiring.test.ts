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

  it('delivers only after the bridge-ready handshake and queues everything before it', () => {
    const functionIndex = mainSource.indexOf('function deliverWorkspacePathLaunch(')
    const readyGuardIndex = mainSource.indexOf('workspacePathBridgeAttached', functionIndex)
    const deliverIndex = mainSource.indexOf("mainWindow.webContents.send('ui:openWorkspacePath'")
    const queueIndex = mainSource.indexOf('workspacePathLaunchQueue.queue(folderPath)')
    expect(readyGuardIndex).toBeGreaterThan(functionIndex)
    expect(deliverIndex).toBeGreaterThan(readyGuardIndex)
    expect(queueIndex).toBeGreaterThan(deliverIndex)
  })

  it('flushes queued launches to the renderer that signals bridge readiness', () => {
    expect(mainSource).toContain("'ui:workspacePathBridgeReady'")
    const handlerIndex = mainSource.indexOf("ipcMain.on('ui:workspacePathBridgeReady'")
    // Why: popouts share the preload, so a foreign sender must never claim readiness.
    const senderGuardIndex = mainSource.indexOf(
      'event.sender !== mainWindow.webContents',
      handlerIndex
    )
    const flushIndex = mainSource.indexOf('workspacePathLaunchQueue.drain()', handlerIndex)
    const senderSendIndex = mainSource.indexOf(
      "event.sender.send('ui:openWorkspacePath'",
      handlerIndex
    )
    expect(handlerIndex).toBeGreaterThan(-1)
    expect(senderGuardIndex).toBeGreaterThan(handlerIndex)
    expect(flushIndex).toBeGreaterThan(senderGuardIndex)
    expect(senderSendIndex).toBeGreaterThan(flushIndex)
  })

  it('revokes bridge readiness when the renderer navigates or its webContents die', () => {
    const assignmentIndex = mainSource.indexOf('mainWindow = window')
    const resetOnLoadIndex = mainSource.indexOf(
      "window.webContents.on('did-start-loading'",
      assignmentIndex
    )
    const resetOnDestroyedIndex = mainSource.indexOf(
      "window.webContents.on('destroyed'",
      assignmentIndex
    )
    expect(resetOnLoadIndex).toBeGreaterThan(assignmentIndex)
    expect(resetOnDestroyedIndex).toBeGreaterThan(resetOnLoadIndex)
    expect(mainSource.slice(resetOnLoadIndex, resetOnLoadIndex + 200)).toContain(
      'workspacePathBridgeAttached = false'
    )
    expect(mainSource.slice(resetOnDestroyedIndex, resetOnDestroyedIndex + 200)).toContain(
      'workspacePathBridgeAttached = false'
    )
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
