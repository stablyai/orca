import { describe, expect, it, vi } from 'vitest'
import { hookMount, performHookAction } from '../test-support/rpc-recording/hook-mount'
import { mountFixture } from '../test-support/rpc-recording/recorder-fixture-shape'
import type { RpcResponse } from '../transport/types'
import type { MarkdownDocState, MobileSessionTab } from './mobile-session-route-types'
import { useMobileSessionDocumentReaders } from './use-mobile-session-document-readers'
import { useMobileSessionCloseActions } from './use-mobile-session-close-actions'

type ReaderScope = Parameters<typeof useMobileSessionDocumentReaders>[0]
type CloseScope = Parameters<typeof useMobileSessionCloseActions>[0]

function success(content: string): RpcResponse {
  return {
    id: 'read',
    ok: true,
    result: { content, version: 'version', isDirty: false, editable: false },
    _meta: { runtimeId: 'host' }
  }
}

function mountDocuments(readReply: () => Promise<RpcResponse>) {
  let docs = new Map<string, MarkdownDocState>()
  const tabs: { current: MobileSessionTab[] } = { current: [] }
  const setDocs: ReaderScope['setMarkdownDocs'] = (update) => {
    docs = typeof update === 'function' ? update(docs) : update
  }
  const closeReply = vi.fn(async (): Promise<RpcResponse> => success(''))
  const client = {
    sendRequest: vi.fn(async (method: string): Promise<RpcResponse> =>
      method === 'markdown.readTab' || method === 'files.read' ? readReply() : closeReply()
    )
  }
  let readers: ReturnType<typeof useMobileSessionDocumentReaders> | undefined
  let close: ReturnType<typeof useMobileSessionCloseActions> | undefined
  const hook = hookMount(() => {
    readers = useMobileSessionDocumentReaders(
      mountFixture<ReaderScope>({
        worktreeId: 'folder-workspace',
        markdownDocsRef: {
          get current() {
            return docs
          }
        },
        client,
        setMarkdownDocs: setDocs,
        setFileDocs: () => {}
      })
    )
    close = useMobileSessionCloseActions(
      mountFixture<CloseScope>({
        worktreeId: 'folder-workspace',
        client,
        sessionTabsRef: tabs,
        setSessionTabs: () => {},
        setFileDocs: () => {},
        setMarkdownDocs: setDocs,
        reconcileBufferedDraftsRef: { current: () => {} },
        closedTabTombstonesRef: { current: new Map() },
        activeSessionTabIdRef: { current: null },
        selectedSessionTabIdRef: { current: null },
        activeSessionTabTypeRef: { current: null },
        activeHandleRef: { current: null },
        setActiveSessionTabId: () => {},
        setActiveHandle: () => {}
      })
    )
  })
  hook.mount()
  const tab = (id: string) =>
    mountFixture<Extract<MobileSessionTab, { type: 'markdown' }>>({
      type: 'markdown',
      id,
      relativePath: id + '.md',
      isDirty: false
    })
  return {
    get docs() {
      return docs
    },
    closeReply,
    unmount: hook.unmount,
    read(id: string) {
      const target = tab(id)
      tabs.current = [...tabs.current.filter((current) => current.id !== id), target]
      return performHookAction(() => readers?.readMarkdownTab(target))
    },
    close(id: string) {
      return performHookAction(() => close?.handleCloseSessionTab(tab(id)))
    },
    dirty(id: string) {
      const doc = docs.get(id)
      if (doc?.status !== 'ready') {
        throw new Error('Missing ready document')
      }
      docs.set(id, { ...doc, localContent: 'phone draft', isDirty: true })
    }
  }
}

function delayedReply() {
  let resolve: (reply: RpcResponse) => void = () => {}
  const promise = new Promise<RpcResponse>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('mobile Markdown document lifetime', () => {
  it('releases only the closed clean document and preserves other cached documents', async () => {
    const readReply = vi
      .fn()
      .mockResolvedValueOnce(success('# a'))
      .mockResolvedValueOnce(success('# b'))
      .mockResolvedValueOnce(success('# c'))
    const h = mountDocuments(readReply)
    try {
      await h.read('a')
      await h.read('b')
      await h.read('c')
      expect(h.docs.get('a')).toMatchObject({ status: 'ready', content: '# a' })
      expect(h.docs.get('b')).toMatchObject({ status: 'ready', content: '# b' })
      expect(h.docs.get('c')).toMatchObject({ status: 'ready', content: '# c' })
      const a = h.docs.get('a')
      const c = h.docs.get('c')
      await h.close('b')
      expect([...h.docs.keys()]).toEqual(['a', 'c'])
      expect(h.docs.get('a')).toBe(a)
      expect(h.docs.get('c')).toBe(c)
      await h.close('a')
      expect([...h.docs.keys()]).toEqual(['c'])
      expect(h.docs.get('c')).toBe(c)
      await h.close('c')
      expect(h.docs.size).toBe(0)
    } finally {
      h.unmount()
    }
  })

  it.each(['success', 'failure', 'disk fallback'])(
    'keeps a closed read released after a late %s',
    async (kind) => {
      const delayed = delayedReply()
      const readReply = vi
        .fn()
        .mockReturnValueOnce(delayed.promise)
        .mockResolvedValue(success('disk'))
      const h = mountDocuments(readReply)
      try {
        const reading = h.read('closed')
        await h.close('closed')
        delayed.resolve(
          kind === 'success'
            ? success('late')
            : {
                id: 'read',
                ok: false,
                error: {
                  code: kind === 'disk fallback' ? 'renderer_unavailable' : 'tab_not_found',
                  message: 'Unavailable'
                },
                _meta: { runtimeId: 'host' }
              }
        )
        await reading
        expect(h.docs.size).toBe(0)
        if (kind === 'disk fallback') {
          expect(readReply).toHaveBeenCalledTimes(2)
        }
      } finally {
        h.unmount()
      }
    }
  )

  it('retains the document when the host refuses close', async () => {
    const h = mountDocuments(async () => success('kept'))
    try {
      await h.read('kept')
      const doc = h.docs.get('kept')
      h.closeReply.mockResolvedValue({
        id: 'close',
        ok: false,
        error: { code: 'refused', message: 'Refused' },
        _meta: { runtimeId: 'host' }
      })
      await h.close('kept')
      expect(h.docs.get('kept')).toBe(doc)
    } finally {
      h.unmount()
    }
  })

  it('preserves unsaved phone drafts after close', async () => {
    const h = mountDocuments(async () => success('original'))
    try {
      await h.read('draft')
      h.dirty('draft')
      const draft = h.docs.get('draft')
      await h.close('draft')
      expect(h.docs.get('draft')).toBe(draft)
    } finally {
      h.unmount()
    }
  })

  it('keeps a newer read when an older request finishes later', async () => {
    const old = delayedReply()
    const h = mountDocuments(
      vi.fn().mockReturnValueOnce(old.promise).mockResolvedValue(success('new'))
    )
    try {
      const first = h.read('same')
      await h.read('same')
      const current = h.docs.get('same')
      old.resolve(success('old'))
      await first
      expect(h.docs.get('same')).toBe(current)
    } finally {
      h.unmount()
    }
  })
})
