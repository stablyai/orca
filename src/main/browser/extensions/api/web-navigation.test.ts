import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import type { BrowserExtensionCaller } from '../browser-extension-namespace-registry'

type FakeFrame = {
  frameTreeNodeId: number
  processId: number
  routingId: number
  url: string
  parent: FakeFrame | null
  isDestroyed: () => boolean
  on: (event: string, listener: () => void) => void
}

const mocks = vi.hoisted(() => {
  const emitted: [string, unknown][] = []
  const state: { tab: unknown } = { tab: null }
  return { frames: new Map<string, unknown>(), emitted, state }
})

vi.mock('electron', () => ({
  webFrameMain: {
    fromId: (processId: number, routingId: number) => mocks.frames.get(`${processId}:${routingId}`)
  }
}))
vi.mock('../browser-extension-api-host', () => ({
  emitBrowserExtensionEvent: (_target: unknown, _namespace: string, event: string, args: unknown) =>
    mocks.emitted.push([event, Array.isArray(args) ? args[0] : undefined])
}))
vi.mock('../browser-extension-tab-model', () => ({
  resolveBrowserExtensionTab: () => mocks.state.tab,
  listBrowserExtensionTabs: () => (mocks.state.tab ? [mocks.state.tab] : [])
}))

const registry = await import('../browser-extension-namespace-registry')
const { observeBrowserExtensionWebNavigation, registerWebNavigationNamespace } =
  await import('./web-navigation')
const { getBrowserExtensionDocumentId } = await import('../browser-extension-document-ids')
const { PRELOAD_DOCUMENT_TARGETS_NAMESPACE } =
  await import('../../../../preload/browser-extension-document-targets')

function frame(frameTreeNodeId: number, url: string, parent: FakeFrame | null = null): FakeFrame {
  const created: FakeFrame = {
    frameTreeNodeId,
    processId: 1,
    routingId: frameTreeNodeId,
    url,
    parent,
    isDestroyed: () => false,
    on: () => {}
  }
  mocks.frames.set(`1:${frameTreeNodeId}`, created)
  return created
}

function lastEvent(name: string): Record<string, unknown> | undefined {
  const details = mocks.emitted.findLast(([event]) => event === name)?.[1]
  return details !== null && typeof details === 'object' ? { ...details } : undefined
}

describe('webNavigation documentIds', () => {
  it('names each committed document, keeps it through same-document changes and links parents', async () => {
    const session = {}
    const main = frame(10, 'https://site.test/')
    const sub = frame(11, 'https://ads.test/frame', main)
    const contents = Object.assign(new EventEmitter(), {
      id: 7,
      session,
      mainFrame: { frameTreeNodeId: 10, framesInSubtree: [main, sub] }
    })
    mocks.state.tab = { contents }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the observer uses only on/once/emit, id, session and mainFrame, all stubbed.
    observeBrowserExtensionWebNavigation(contents as unknown as Electron.WebContents)

    contents.emit('did-start-navigation', { url: main.url, isSameDocument: false, frame: main })
    expect(lastEvent('onBeforeNavigate')).not.toHaveProperty('documentId')
    contents.emit('did-frame-navigate', {}, main.url, 200, 'OK', true, 1, 10)
    const committed = lastEvent('onCommitted')
    expect(committed).toMatchObject({
      frameId: 0,
      parentFrameId: -1,
      documentId: expect.stringMatching(/^[0-9A-F]{32}$/),
      frameType: 'outermost_frame',
      documentLifecycle: 'active'
    })
    expect(committed).not.toHaveProperty('parentDocumentId')
    const firstDocument = committed?.documentId

    contents.emit('did-start-navigation', { url: sub.url, isSameDocument: false, frame: sub })
    expect(lastEvent('onBeforeNavigate')).toMatchObject({
      frameId: 11,
      parentDocumentId: firstDocument,
      frameType: 'sub_frame'
    })
    contents.emit('did-frame-navigate', {}, sub.url, 200, 'OK', false, 1, 11)
    const subDocument = lastEvent('onCommitted')?.documentId
    expect(lastEvent('onCommitted')).toMatchObject({ frameId: 11, parentDocumentId: firstDocument })
    expect(subDocument).not.toBe(firstDocument)

    contents.emit('did-navigate-in-page', {}, 'https://site.test/#top', true, 1, 10)
    expect(lastEvent('onReferenceFragmentUpdated')?.documentId).toBe(firstDocument)
    contents.emit('did-frame-finish-load', {}, true, 1, 10)
    expect(lastEvent('onCompleted')?.documentId).toBe(firstDocument)

    registerWebNavigationNamespace()
    const caller = {
      extension: { id: 'x', manifest: { permissions: ['webNavigation'] } },
      session,
      browserProfileId: 'default'
    }
    const invoke = (method: string, args: unknown[], namespace = 'webNavigation') =>
      registry.getBrowserExtensionNamespace(namespace)?.methods[method].invoke(
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the frame getters read only the caller's extension manifest and session.
        caller as unknown as BrowserExtensionCaller,
        args
      )
    // The preload maps Orca's ids to frames for native scripting through this list.
    expect(invoke('frames', [7], PRELOAD_DOCUMENT_TARGETS_NAMESPACE)).toEqual([
      { frameId: 0, documentId: firstDocument },
      { frameId: 11, documentId: subDocument }
    ])
    expect(invoke('getAllFrames', [{ tabId: 7 }])).toEqual([
      expect.objectContaining({ frameId: 0, documentId: firstDocument }),
      expect.objectContaining({
        frameId: 11,
        documentId: subDocument,
        parentDocumentId: firstDocument
      })
    ])
    // Any outermost frame is frame 0, also when asked for by its frame-tree id (a native sender's).
    for (const frameId of [0, 10]) {
      expect(invoke('getFrame', [{ tabId: 7, frameId }])).toMatchObject({
        frameId: 0,
        parentFrameId: -1,
        frameType: 'outermost_frame',
        documentId: firstDocument
      })
    }
    expect(invoke('getFrame', [{ tabId: 7, frameId: 11 }])).toMatchObject({ frameId: 11 })
    expect(invoke('getFrame', [{ documentId: subDocument }])).toMatchObject({
      frameId: 11,
      url: sub.url,
      frameType: 'sub_frame'
    })

    // A cross-document commit is a new document; the old id names nothing.
    contents.emit('did-frame-navigate', {}, 'https://site.test/next', 200, 'OK', true, 1, 10)
    const nextDocument = lastEvent('onCommitted')?.documentId
    expect(nextDocument).not.toBe(firstDocument)
    expect(invoke('getFrame', [{ documentId: firstDocument }])).toBeNull()

    contents.emit('destroyed')
    expect(getBrowserExtensionDocumentId(10)).not.toBe(nextDocument)
  })
})
