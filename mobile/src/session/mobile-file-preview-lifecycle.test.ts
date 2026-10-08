import type { Dispatch, SetStateAction } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { hookMount, performHookAction } from '../test-support/rpc-recording/hook-mount'
import { mountFixture } from '../test-support/rpc-recording/recorder-fixture-shape'
import type { RpcResponse } from '../transport/types'
import type { FileDocState, MobileSessionTab } from './mobile-session-route-types'
import { useMobileSessionCloseActions } from './use-mobile-session-close-actions'
import { useMobileSessionDocumentReaders } from './use-mobile-session-document-readers'

type FileTab = Extract<MobileSessionTab, { type: 'file' }>
const META = { runtimeId: 'runtime-1' }

function fileTab(id: string): FileTab {
  return {
    type: 'file',
    id,
    title: id,
    filePath: `/workspace/${id}.txt`,
    relativePath: `${id}.txt`,
    isDirty: false,
    isActive: false
  }
}

function acceptedReply(result: unknown): RpcResponse {
  return { id: 'reply-1', ok: true, result, _meta: META }
}

function refusedReply(): RpcResponse {
  return {
    id: 'reply-1',
    ok: false,
    error: { code: 'runtime_error', message: 'Unable to read or close' },
    _meta: META
  }
}

function textReply(content: string): RpcResponse {
  return acceptedReply({ content, truncated: false, byteLength: content.length })
}

function pendingReadReply() {
  let resolve!: (reply: RpcResponse) => void
  const promise = new Promise<RpcResponse>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

function previewSession() {
  const keptTab = fileTab('kept')
  const keptDoc: FileDocState = {
    status: 'ready',
    kind: 'image',
    dataUri: 'data:image/png;base64,AA=='
  }
  let docs = new Map<string, FileDocState>([[keptTab.id, keptDoc]])
  const sessionTabsRef: { current: MobileSessionTab[] } = { current: [keptTab] }
  const reads: ReturnType<typeof pendingReadReply>[] = []
  let closeReply: RpcResponse | Error = acceptedReply({})
  const client = {
    sendRequest: vi.fn(async (method: string): Promise<RpcResponse> => {
      if (method === 'session.tabs.close') {
        if (closeReply instanceof Error) {
          throw closeReply
        }
        return closeReply
      }
      expect(method).toBe('files.read')
      const read = pendingReadReply()
      reads.push(read)
      return read.promise
    })
  }
  const setFileDocs: Dispatch<SetStateAction<Map<string, FileDocState>>> = (update) => {
    docs = typeof update === 'function' ? update(docs) : update
  }
  let closeActions: ReturnType<typeof useMobileSessionCloseActions> | undefined
  let readers: ReturnType<typeof useMobileSessionDocumentReaders> | undefined
  const hook = hookMount(() => {
    closeActions = useMobileSessionCloseActions(
      mountFixture<Parameters<typeof useMobileSessionCloseActions>[0]>({
        worktreeId: 'wt-1',
        client,
        sessionTabsRef,
        setSessionTabs: () => {},
        setFileDocs,
        reconcileBufferedDraftsRef: { current: () => {} },
        closedTabTombstonesRef: { current: new Map() },
        pendingBrowserFocusPageIdRef: { current: null },
        activeSessionTabIdRef: { current: keptTab.id }
      })
    )
    readers = useMobileSessionDocumentReaders(
      mountFixture<Parameters<typeof useMobileSessionDocumentReaders>[0]>({
        worktreeId: 'wt-1',
        client,
        setFileDocs,
        setMarkdownDocs: () => {}
      })
    )
  })
  hook.mount()
  return {
    keptTab,
    keptDoc,
    docs: () => docs,
    tabs: () => sessionTabsRef.current,
    open(tab: FileTab, doc?: FileDocState) {
      sessionTabsRef.current = [...sessionTabsRef.current, tab]
      if (doc) {
        docs.set(tab.id, doc)
      }
    },
    setCloseReply(reply: RpcResponse | Error) {
      closeReply = reply
    },
    close(tab: FileTab) {
      if (!closeActions) {
        throw new Error('Close actions not mounted')
      }
      const actions = closeActions
      return performHookAction(() => actions.handleCloseSessionTab(tab))
    },
    read(tab: FileTab) {
      if (!readers) {
        throw new Error('Document readers not mounted')
      }
      const actions = readers
      return performHookAction(() => actions.readFileTab(tab))
    },
    reply(index: number, response: RpcResponse) {
      const read = reads[index]
      if (!read) {
        throw new Error(`Missing pending read ${index}`)
      }
      read.resolve(response)
    },
    dispose: hook.unmount
  }
}

describe('mobile file preview lifetime', () => {
  it('releases successfully closed previews through repeated tab churn and keeps open caches', async () => {
    const session = previewSession()
    try {
      for (let index = 0; index < 64; index++) {
        const tab = fileTab(`closed-${index}`)
        session.open(tab, { status: 'ready', kind: 'html', content: `Preview ${index}` })
        await session.close(tab)
      }
      expect(session.tabs()).toEqual([session.keptTab])
      expect([...session.docs()]).toEqual([[session.keptTab.id, session.keptDoc]])
    } finally {
      session.dispose()
    }
  })

  it.each([refusedReply(), new Error('Disconnected')])(
    'keeps a preview when closing fails: %s',
    async (reply) => {
      const session = previewSession()
      const tab = fileTab('still-open')
      const doc: FileDocState = {
        status: 'ready',
        kind: 'image',
        dataUri: 'data:image/png;base64,AQ=='
      }
      try {
        session.open(tab, doc)
        session.setCloseReply(reply)
        await session.close(tab)
        expect(session.tabs()).toContain(tab)
        expect(session.docs().get(tab.id)).toBe(doc)
        expect(session.docs().get(session.keptTab.id)).toBe(session.keptDoc)
      } finally {
        session.dispose()
      }
    }
  )

  it.each([textReply('Late content'), refusedReply()])(
    'does not recreate a closed preview from a late read: %s',
    async (reply) => {
      const session = previewSession()
      const tab = fileTab('closing')
      try {
        session.open(tab)
        const reading = session.read(tab)
        expect(session.docs().get(tab.id)).toEqual({ status: 'loading' })
        await session.close(tab)
        session.reply(0, reply)
        await reading
        expect(session.docs().has(tab.id)).toBe(false)
        expect(session.docs().get(session.keptTab.id)).toBe(session.keptDoc)
      } finally {
        session.dispose()
      }
    }
  )

  it.each([textReply('Old content'), refusedReply()])(
    'keeps the new read when a tab ID reopens before its old read settles: %s',
    async (oldReply) => {
      const session = previewSession()
      const tab = fileTab('reopened')
      try {
        session.open(tab)
        const oldReading = session.read(tab)
        await session.close(tab)
        session.open(tab)
        const newReading = session.read(tab)
        session.reply(1, textReply('New content'))
        await newReading
        const newDoc = session.docs().get(tab.id)
        expect(newDoc).toMatchObject({ status: 'ready', kind: 'file', content: 'New content' })
        session.reply(0, oldReply)
        await oldReading
        expect(session.docs().get(tab.id)).toBe(newDoc)
        expect(session.tabs()).toContain(tab)
      } finally {
        session.dispose()
      }
    }
  )
})
