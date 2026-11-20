import { EventEmitter } from 'node:events'
import { expect, it, vi } from 'vitest'

const { handlers, snapshotRequested, sources } = vi.hoisted(() => ({
  sources: new Map<number, Renderer>(),
  handlers: new Map<string, (...args: any[]) => unknown>(),
  snapshotRequested: vi.fn()
}))

vi.mock('electron', () => ({
  app: { focus: vi.fn() },
  ipcMain: {
    handle: (channel: string, handler: (...args: any[]) => unknown) =>
      handlers.set(channel, handler),
    removeHandler: (channel: string) => handlers.delete(channel)
  },
  BrowserWindow: {
    fromWebContents: (sender: { id: number }) => ({ id: sender.id + 10 }),
    getAllWindows: () => []
  },
  webContents: { fromId: (id: number) => sources.get(id) }
}))
vi.mock('../../window/dashboard-popout-window', () => ({
  createOrFocusDashboardPopout: vi.fn(),
  closeDashboardPopout: vi.fn(),
  getDashboardPopoutWindow: () => null,
  isDashboardPopoutRenderer: () => false,
  onDashboardPopoutOpenChanged: vi.fn()
}))
vi.mock('../../window/activation/focus-existing-window', () => ({ safelyRevealWindow: vi.fn() }))
vi.mock('../../window/activation/foreground-activation-policy', () => ({
  isBackgroundLaunch: () => true
}))
vi.mock('../ui', () => ({
  getTrustedUIRendererWindow: () => null,
  isTrustedUIRenderer: () => false,
  sendToTrustedUIRenderer: snapshotRequested
}))

import { registerDashboardPopoutHandlers } from '../dashboard/dashboard-popout'
import { installElectronAppIpc } from './electron-app-ipc'
import {
  appDocumentFor,
  publishToDocuments,
  registerAppHandler,
  type AppCaller
} from './app-handler-registry'

class Renderer extends EventEmitter {
  mainFrame = { parent: null, detached: false }
  send = vi.fn()
  constructor(readonly id: number) {
    super()
    sources.set(id, this)
  }
  isDestroyed(): boolean {
    return false
  }
}

it('admits only the popout document and fences its retired generation', () => {
  installElectronAppIpc((sender) => (sender.id === 2 ? 'dashboard-popout' : 'document'))
  const store = {
    getSettings: () => ({ experimentalAgentDashboardPopout: true }),
    onSettingsChanged: vi.fn()
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this flow only reads settings and registers its listener.
  registerDashboardPopoutHandlers(store as never)
  const ordinary = new Renderer(1)
  const popout = new Renderer(2)
  const request = handlers.get('dashboard:requestSnapshot')!
  request({ sender: ordinary, senderFrame: ordinary.mainFrame })
  expect(snapshotRequested).not.toHaveBeenCalled()
  request({ sender: popout, senderFrame: popout.mainFrame })
  expect(snapshotRequested).toHaveBeenCalledWith('dashboard:snapshotRequested', null)

  const identities: AppCaller[] = []
  registerAppHandler('ui:get', (caller) => {
    identities.push(caller)
  })
  const identify = handlers.get('ui:get')!
  identify({ sender: popout, senderFrame: popout.mainFrame })
  const retired = identities[0]
  const document = appDocumentFor(retired)
  const gone = vi.fn()
  document.once('destroyed', gone)
  const oldFrame = popout.mainFrame
  popout.mainFrame = { parent: null, detached: false }
  popout.emit('did-navigate')
  expect(gone).toHaveBeenCalledOnce()
  expect(document.isDestroyed()).toBe(true)
  expect(() => request({ sender: popout, senderFrame: oldFrame })).toThrow('document has retired')
  publishToDocuments('dashboard:snapshot', { stale: true }, retired)
  expect(popout.send).not.toHaveBeenCalled()
  identify({ sender: popout, senderFrame: popout.mainFrame })
  const successor = identities[1]
  expect(successor.documentId).not.toBe(retired.documentId)
  publishToDocuments('dashboard:snapshot', { current: true }, successor)
  expect(popout.send).toHaveBeenCalledWith('dashboard:snapshot', { current: true })
})

it('refuses preview grants resumed after retirement and revokes successor previews on close', async () => {
  const { mintPreviewUrl, previewGrantForSender } =
    await import('../../media/preview-grant-registry')
  installElectronAppIpc(() => 'main')
  const renderer = new Renderer(3)
  const authorization = Promise.withResolvers<void>()
  registerAppHandler('fs:readFile', async (caller) => {
    await authorization.promise
    return mintPreviewUrl(
      appDocumentFor(caller),
      { filePath: '/workspace/movie.mp4' },
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: minting retains the store without reading it.
      {} as never,
      { kind: 'video', mimeType: 'video/mp4' }
    )
  })
  const read = handlers.get('fs:readFile')!
  const pending = Promise.resolve(read({ sender: renderer, senderFrame: renderer.mainFrame }))
  renderer.mainFrame = { parent: null, detached: false }
  renderer.emit('did-navigate')
  authorization.resolve()
  await expect(pending).rejects.toThrow('Preview document has retired')
  const current = await read({ sender: renderer, senderFrame: renderer.mainFrame })
  if (
    !current ||
    typeof current !== 'object' ||
    !('mediaUrl' in current) ||
    typeof current.mediaUrl !== 'string'
  ) {
    throw new Error('Expected a preview URL')
  }
  expect(previewGrantForSender(current.mediaUrl, 3)?.grant.mimeType).toBe('video/mp4')
  renderer.emit('destroyed')
  expect(previewGrantForSender(current.mediaUrl, 3)).toBeNull()
})
