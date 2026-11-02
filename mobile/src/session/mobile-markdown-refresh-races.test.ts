import { useRef, useState } from 'react'
import { act } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { hookMount, performHookAction } from '../test-support/rpc-recording/hook-mount'
import { mountFixture } from '../test-support/rpc-recording/recorder-fixture-shape'
import type { RpcResponse } from '../transport/types'
import type { MarkdownDocState, MobileSessionTab } from './mobile-session-route-types'
import { useMobileSessionDocumentReaders } from './use-mobile-session-document-readers'
import { useMobileSessionMarkdownActions } from './use-mobile-session-markdown-actions'

vi.mock('react-native', () => ({
  Platform: { OS: 'web' },
  Keyboard: { dismiss: vi.fn() }
}))
vi.mock('../navigation/use-back-claim', () => ({ useBackClaim: () => {} }))
vi.mock('../platform/clipboard', () => ({
  useClipboardWriter: () => ({ writeText: vi.fn() })
}))
vi.mock('../platform/haptics', () => ({ triggerSuccess: vi.fn(), triggerError: vi.fn() }))

type ReaderScope = Parameters<typeof useMobileSessionDocumentReaders>[0]
type ActionsScope = Parameters<typeof useMobileSessionMarkdownActions>[0]
type ReadyMarkdown = Extract<MarkdownDocState, { status: 'ready' }>

const tab: Extract<MobileSessionTab, { type: 'markdown' }> = {
  type: 'markdown',
  id: 'tab-md',
  title: 'README.md',
  filePath: '/workspace/README.md',
  relativePath: 'README.md',
  isDirty: false,
  isActive: true,
  documentVersion: 'v1'
}

function initialDocument(): ReadyMarkdown {
  return {
    status: 'ready',
    content: '# cached',
    localContent: '# cached',
    baseVersion: 'v1',
    isDirty: false,
    editable: true,
    stale: false
  }
}

function reply(content = '# current desktop', version = 'v2'): RpcResponse {
  return {
    id: 'reply',
    ok: true,
    result: { tabId: tab.id, content, version, isDirty: false, editable: true },
    _meta: { runtimeId: 'ssh-host' }
  }
}

function deferredReply() {
  let resolve: (value: RpcResponse) => void = () => {}
  const promise = new Promise<RpcResponse>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const mounted: Array<() => void> = []
afterEach(() => {
  for (const unmount of mounted.splice(0)) {
    unmount()
  }
})

function mountDocument(
  readReply: () => Promise<RpcResponse>,
  saveReply: () => Promise<RpcResponse> = async () => reply('# cached', 'v1')
) {
  let model:
    | {
        readers: ReturnType<typeof useMobileSessionDocumentReaders>
        actions: ReturnType<typeof useMobileSessionMarkdownActions>
        docs: Map<string, MarkdownDocState>
        setDocs: ReaderScope['setMarkdownDocs']
      }
    | undefined
  const client = {
    sendRequest: vi.fn((method: string) => {
      if (method === 'markdown.readTab') {
        return readReply()
      }
      if (method === 'markdown.saveTab') {
        return saveReply()
      }
      throw new Error('Unexpected RPC: ' + method)
    })
  }
  const hook = hookMount(() => {
    const [docs, setDocs] = useState<Map<string, MarkdownDocState>>(
      () => new Map([[tab.id, initialDocument()]])
    )
    const markdownDocsRef = useRef<Map<string, MarkdownDocState>>(docs)
    markdownDocsRef.current = docs
    const markdownSaveSeqRef = useRef(new Map<string, number>())
    const markdownSaveInFlightRef = useRef(new Set<string>())
    const readers = useMobileSessionDocumentReaders(
      mountFixture<ReaderScope>({
        worktreeId: 'folder:remote',
        client,
        markdownDocsRef,
        setMarkdownDocs: setDocs,
        setFileDocs: () => {}
      })
    )
    const actions = useMobileSessionMarkdownActions(
      mountFixture<ActionsScope>({
        hostId: 'ssh-host',
        worktreeId: 'folder:remote',
        client,
        sessionTabs: [tab],
        markdownDocs: docs,
        setMarkdownDocs: setDocs,
        setDiscardMarkdownTarget: () => {},
        discardMarkdownTarget: null,
        setLeaveDrafts: () => {},
        markdownSaveSeqRef,
        markdownSaveInFlightRef,
        showToast: () => {},
        readMarkdownTab: readers.readMarkdownTab,
        dictationLeaveHold: { holdsLeave: false, hold: () => false }
      })
    )
    model = { readers, actions, docs, setDocs }
  })
  hook.mount()
  mounted.push(hook.unmount)
  function current() {
    if (!model) {
      throw new Error('Document hooks are not mounted')
    }
    return model
  }
  function markStale() {
    current().setDocs((prev) => {
      const doc = prev.get(tab.id)
      if (doc?.status !== 'ready') {
        throw new Error('Expected a ready document')
      }
      return new Map(prev).set(tab.id, { ...doc, stale: true })
    })
  }
  return {
    get doc() {
      return current().docs.get(tab.id)
    },
    read: () => performHookAction(() => current().readers.readMarkdownTab(tab)),
    save: () => performHookAction(() => current().actions.saveMarkdownTab(tab)),
    edit: (text: string) =>
      performHookAction(() => current().actions.updateMarkdownLocalContent(tab.id, text)),
    markStale: () => performHookAction(markStale),
    markStaleAndRead: () =>
      performHookAction(() => {
        markStale()
        return current().readers.readMarkdownTab(tab)
      })
  }
}

async function finish(
  pending: ReturnType<typeof deferredReply>,
  operation: Promise<void>,
  response = reply()
) {
  await act(async () => {
    pending.resolve(response)
    await operation
  })
}

describe('Markdown refresh races through the real reader and edit/save hooks', () => {
  it.each(['during read', 'same event'])(
    'accepts fresh desktop text after metadata-only stale updates: %s',
    async (timing) => {
      const pending = deferredReply()
      const h = mountDocument(() => pending.promise)
      const reading = timing === 'same event' ? h.markStaleAndRead() : h.read()
      h.markStale()
      h.markStale()
      await finish(pending, reading)
      expect(h.doc).toMatchObject({
        content: '# current desktop',
        localContent: '# current desktop',
        baseVersion: 'v2',
        stale: true
      })
      await act(async () => {
        await h.read()
      })
      expect(h.doc).toMatchObject({ content: '# current desktop', stale: false })
    }
  )

  it('preserves a phone edit followed by undo while a stale-marked read is pending', async () => {
    const pending = deferredReply()
    const h = mountDocument(() => pending.promise)
    const reading = h.read()
    h.edit('# phone edit')
    h.edit('# cached')
    h.markStale()
    const beforeReply = h.doc
    await finish(pending, reading)
    expect(h.doc).toBe(beforeReply)
    expect(h.doc).toMatchObject({ content: '# cached', localContent: '# cached', isDirty: false })
  })

  it.each(['before read', 'after read'])(
    'preserves a save of identical bytes and version begun %s',
    async (timing) => {
      const pendingRead = deferredReply()
      const pendingSave = deferredReply()
      const h = mountDocument(
        () => pendingRead.promise,
        () => pendingSave.promise
      )
      const saving = timing === 'before read' ? h.save() : undefined
      const reading = h.read()
      const saveOperation = saving ?? h.save()
      h.markStale()
      await finish(pendingSave, saveOperation, reply('# cached', 'v1'))
      const saved = h.doc
      await finish(pendingRead, reading)
      expect(h.doc).toBe(saved)
      expect(h.doc).toMatchObject({ content: '# cached', baseVersion: 'v1', isDirty: false })
    }
  )

  it('does not replace an in-flight phone save when the read finishes first', async () => {
    const pendingRead = deferredReply()
    const pendingSave = deferredReply()
    const h = mountDocument(
      () => pendingRead.promise,
      () => pendingSave.promise
    )
    const reading = h.read()
    const saving = h.save()
    const duringSave = h.doc
    await finish(pendingRead, reading)
    expect(h.doc).toBe(duringSave)
    expect(h.doc).toMatchObject({ saving: true })
    await finish(pendingSave, saving, reply('# cached', 'v1'))
  })

  it('retains the save failure after its request finishes during a read', async () => {
    const pendingRead = deferredReply()
    const pendingSave = deferredReply()
    const h = mountDocument(
      () => pendingRead.promise,
      () => pendingSave.promise
    )
    const reading = h.read()
    const saving = h.save()
    await finish(pendingSave, saving, {
      id: 'save',
      ok: false,
      error: { code: 'runtime_error', message: 'Save refused' },
      _meta: { runtimeId: 'ssh-host' }
    })
    const failed = h.doc
    await finish(pendingRead, reading)
    expect(h.doc).toBe(failed)
    expect(h.doc).toMatchObject({ saving: false, saveError: 'Save refused' })
  })

  it('accepts a fresh read started after a completed save', async () => {
    const pendingRead = deferredReply()
    const pendingSave = deferredReply()
    const h = mountDocument(
      () => pendingRead.promise,
      () => pendingSave.promise
    )
    await finish(pendingSave, h.save(), reply('# cached', 'v1'))
    const reading = h.read()
    h.markStale()
    await finish(pendingRead, reading)
    expect(h.doc).toMatchObject({
      content: '# current desktop',
      localContent: '# current desktop',
      baseVersion: 'v2'
    })
  })
})
