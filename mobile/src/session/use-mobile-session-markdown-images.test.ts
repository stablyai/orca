import { describe, expect, it, vi } from 'vitest'
import { hookMount, performHookAction } from '../test-support/rpc-recording/hook-mount'
import { mountFixture } from '../test-support/rpc-recording/recorder-fixture-shape'
import type { RpcResponse } from '../transport/types'
import type { MarkdownDocState } from './mobile-session-route-types'
import { useMobileSessionDocumentReaders } from './use-mobile-session-document-readers'
import { useMobileSessionMarkdownActions } from './use-mobile-session-markdown-actions'

vi.mock('react-native', () => ({ Keyboard: { dismiss: () => {} }, Platform: { OS: 'web' } }))
vi.mock('../navigation/use-back-claim', () => ({ useBackClaim: () => {} }))
vi.mock('../platform/clipboard', () => ({
  useClipboardWriter: () => ({ writeText: async () => {} })
}))
vi.mock('../platform/haptics', () => ({ triggerSuccess: () => {}, triggerError: () => {} }))

const CONTENT = '# Document\n\n![Shot](shot.png)'
const TAB = {
  type: 'markdown',
  id: 'tab-md',
  relativePath: 'docs/intro.md',
  isDirty: false
} as const
const answer = (result: unknown): RpcResponse => ({
  id: 'reply',
  ok: true,
  result,
  _meta: { runtimeId: 'runtime-1' }
})
const settleImages = () => new Promise((resolve) => setTimeout(resolve, 0))
const image = (content: string) => answer({ content, isImage: true, mimeType: 'image/png' })

function harness() {
  let docs = new Map<string, MarkdownDocState>()
  let readers: ReturnType<typeof useMobileSessionDocumentReaders> | undefined
  let actions: ReturnType<typeof useMobileSessionMarkdownActions> | undefined
  const pendingImages: ReturnType<typeof Promise.withResolvers<RpcResponse>>[] = []
  const pendingSaves: ReturnType<typeof Promise.withResolvers<RpcResponse>>[] = []
  const client = {
    sendRequest: async (method: string): Promise<RpcResponse> => {
      if (method === 'markdown.readTab') {
        return answer({
          tabId: TAB.id,
          content: CONTENT,
          version: 'v1',
          editable: true,
          isDirty: false
        })
      }
      const pending = Promise.withResolvers<RpcResponse>()
      if (method === 'files.readPreview') {
        pendingImages.push(pending)
      } else if (method === 'markdown.saveTab') {
        pendingSaves.push(pending)
      } else {
        throw new Error(method)
      }
      return pending.promise
    }
  }
  const setMarkdownDocs: Parameters<
    typeof useMobileSessionDocumentReaders
  >[0]['setMarkdownDocs'] = (update) => {
    docs = typeof update === 'function' ? update(docs) : update
  }
  const hook = hookMount(() => {
    readers = useMobileSessionDocumentReaders(
      mountFixture<Parameters<typeof useMobileSessionDocumentReaders>[0]>({
        worktreeId: 'wt-1',
        client,
        setMarkdownDocs,
        setFileDocs: () => {}
      })
    )
    actions = useMobileSessionMarkdownActions(
      mountFixture<Parameters<typeof useMobileSessionMarkdownActions>[0]>({
        hostId: 'host-1',
        worktreeId: 'wt-1',
        client,
        markdownDocs: docs,
        setMarkdownDocs,
        sessionTabs: [],
        discardMarkdownTarget: null,
        setDiscardMarkdownTarget: () => {},
        setLeaveDrafts: () => {},
        markdownSaveSeqRef: { current: new Map() },
        markdownSaveInFlightRef: { current: new Set() },
        showToast: () => {},
        readMarkdownTab: async () => {}
      })
    )
  })
  hook.mount()
  return {
    hook,
    pendingImages,
    pendingSaves,
    read: async () => {
      if (!readers) {
        throw new Error('readers unavailable')
      }
      await performHookAction(() =>
        readers?.readMarkdownTab(mountFixture<Parameters<typeof readers.readMarkdownTab>[0]>(TAB))
      )
      hook.update()
    },
    ready: () => {
      const doc = docs.get(TAB.id)
      if (doc?.status !== 'ready') {
        throw new Error('document not ready')
      }
      return doc
    },
    edit: () => {
      const doc = docs.get(TAB.id)
      if (doc?.status !== 'ready') {
        throw new Error('document not ready')
      }
      docs.set(TAB.id, { ...doc, localContent: CONTENT + '\n\nDraft', isDirty: true })
      hook.update()
    },
    close: () => docs.delete(TAB.id),
    save: () => {
      if (!actions) {
        throw new Error('actions unavailable')
      }
      return performHookAction(() =>
        actions?.saveMarkdownTab(mountFixture<Parameters<typeof actions.saveMarkdownTab>[0]>(TAB))
      )
    }
  }
}

describe('Markdown image read ownership', () => {
  it('publishes text before images settle and preserves a local draft on arrival', async () => {
    const h = harness()
    try {
      await h.read()
      expect(h.ready().content).toBe(CONTENT)
      h.edit()
      h.pendingImages[0]?.resolve(image('QUJD'))
      await settleImages()
      expect(h.ready()).toMatchObject({
        localContent: CONTENT + '\n\nDraft',
        isDirty: true,
        imageSources: { 'shot.png': 'data:image/png;base64,QUJD' }
      })
    } finally {
      h.hook.unmount()
    }
  })

  it('ignores an older image reply after reloading identical document content', async () => {
    const h = harness()
    try {
      await h.read()
      await h.read()
      h.pendingImages[1]?.resolve(image('REVG'))
      await settleImages()
      h.pendingImages[0]?.resolve(image('QUJD'))
      await settleImages()
      expect(h.ready().imageSources).toEqual({ 'shot.png': 'data:image/png;base64,REVG' })
    } finally {
      h.hook.unmount()
    }
  })

  it('does not recreate a closed document when its image reply arrives', async () => {
    const h = harness()
    try {
      await h.read()
      h.close()
      h.pendingImages[0]?.resolve(image('QUJD'))
      await settleImages()
      expect(() => h.ready()).toThrow('document not ready')
    } finally {
      h.hook.unmount()
    }
  })

  it('accepts a pending image after a successful Save preserves its owner', async () => {
    const h = harness()
    try {
      await h.read()
      h.edit()
      const saving = h.save()
      h.pendingSaves[0]?.resolve(
        answer({ tabId: TAB.id, content: CONTENT + '\n\nDraft', version: 'v2', isDirty: false })
      )
      await saving
      h.pendingImages[0]?.resolve(image('QUJD'))
      await settleImages()
      expect(h.ready().imageSources).toEqual({ 'shot.png': 'data:image/png;base64,QUJD' })
      expect(h.ready().isDirty).toBe(false)
    } finally {
      h.hook.unmount()
    }
  })

  it('retains the current image map when an image arrives while Save is pending', async () => {
    const h = harness()
    try {
      await h.read()
      h.edit()
      const saving = h.save()
      h.pendingImages[0]?.resolve(image('QUJD'))
      await settleImages()
      h.pendingSaves[0]?.resolve(
        answer({ tabId: TAB.id, content: CONTENT + '\n\nDraft', version: 'v2', isDirty: false })
      )
      await saving
      expect(h.ready().imageSources).toEqual({ 'shot.png': 'data:image/png;base64,QUJD' })
      expect(h.ready().isDirty).toBe(false)
    } finally {
      h.hook.unmount()
    }
  })
})
