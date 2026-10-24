import { expect, it, vi } from 'vitest'
import type { AgentSessionQueuedMessage } from '../../../src/shared/agent-session-wire'

const disk = vi.hoisted(() => new Map<string, string>())
const io = vi.hoisted(() => ({ beforeSet: async (_key: string, _value: string) => {} }))
vi.mock('react-native', () => ({ AppState: { addEventListener: () => ({ remove() {} }) } }))
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async (key: string) => disk.get(key) ?? null,
    getAllKeys: async () => [...disk.keys()],
    setItem: async (key: string, value: string) => {
      await io.beforeSet(key, value)
      disk.set(key, value)
    },
    removeItem: async (key: string) => {
      disk.delete(key)
    }
  }
}))

it.each(['stored', 'pending', 'disposed'] as const)(
  'refuses actual queued Delete after native %s copy authority ends before acknowledgment',
  async (schedule) => {
    vi.resetModules()
    disk.clear()
    io.beforeSet = async () => {}
    const native = await import('./mobile-native-chat-draft-native-storage')
    const bridge = await import('../mobile-web-shell/bridge/bridge-draft-storage')
    const { BRIDGE_CHAT_DRAFT_STORAGE_GRANT, storageReadParamsSchema } =
      await import('../mobile-web-shell/bridge/bridge-native-verbs')
    const check = native.nativeChatDraftSession('ack-document')
    const writer = bridge.createBridgeDraftWriter({
      mayWrite: () => true,
      check,
      commit: native.writeNativeMobileChatDraft,
      removeWorkspace: native.removeStoredMobileChatDrafts
    })
    // Native and page modules retain independent authority, as in the shipping shell.
    vi.resetModules()
    const page = await import('../mobile-web-shell/bridge/page-draft-storage')
    const owner = await import('./mobile-native-chat-draft-store')
    const storage = await import('./mobile-native-chat-draft-storage')
    const { createFakeBridgePortPair } =
      await import('../mobile-web-shell/bridge/bridge-port-pair-test-harness')
    const pair = createFakeBridgePortPair({
      routeGrants: [BRIDGE_CHAT_DRAFT_STORAGE_GRANT],
      serveNativeVerb: async (verb, params) => {
        if (verb === 'native.storage.read') {
          return {
            value: await native.readNativeMobileChatDraft(
              storageReadParamsSchema.parse(params).key,
              check
            )
          }
        }
        if (verb === 'native.storage.write') {
          return writer.write(params)
        }
        throw new Error(`Unexpected native verb: ${verb}`)
      }
    })
    const scope = 'native-ack\0workspace\0tab'
    const key = 'orca:mobileChatDraft:native-ack:workspace:tab'
    if (schedule === 'stored') {
      disk.set(key, JSON.stringify({ text: 'saved before Edit', images: [] }))
    }
    await pair.flush()
    page.installPageChatDraftStorage(pair.client)
    const hydration = owner.hydrateMobileNativeChatDraft(scope)
    await pair.flush()
    await hydration
    let release = () => {}
    let entered = () => {}
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    io.beforeSet = async () => {
      entered()
      await gate
    }
    const { createElement } = await import('react')
    const { act, create } = await import('react-test-renderer')
    const { useMobileQueuedMessageComposerActions } =
      await import('./use-mobile-queued-message-composer-actions')
    const deleteRemoteQueue = vi.fn(async () => {
      throw new Error('Revoked copy must not delete')
    })
    const feedback = vi.fn()
    let actions: ReturnType<typeof useMobileQueuedMessageComposerActions>
    function Harness() {
      actions = useMobileQueuedMessageComposerActions({
        sessionKey: scope,
        sessionId: 'chat',
        messages: [
          {
            messageId: 'Q',
            position: 1,
            state: 'waiting',
            body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'queued Q' }] }
          }
        ],
        copyCapable: true,
        reorderCapable: false,
        queuedImageCards: false,
        enabled: true,
        promptPending: false,
        copyQueuedMessage: () =>
          owner.appendMobileNativeChatDraft(scope, { text: 'queued Q', images: [] }),
        mutate: deleteRemoteQueue,
        onSendError: feedback
      })
      return null
    }
    let rendered: ReturnType<typeof create> | undefined
    try {
      await act(async () => {
        rendered = create(createElement(Harness))
      })
      let edit: Promise<boolean>
      await act(async () => {
        edit = actions.copyEdit!('Q')
        await pair.flush()
        await started
      })
      let cleanup: Promise<void> = Promise.resolve()
      if (schedule === 'disposed') {
        writer.dispose()
      } else {
        cleanup = native.removeStoredMobileChatDrafts('native-ack', 'workspace')
        expect(() => check(key)).toThrow()
      }
      release()
      await act(async () => {
        await cleanup
        await pair.flush()
        expect(await edit).toBe(false)
      })
      expect(deleteRemoteQueue).not.toHaveBeenCalled()
      expect(feedback).toHaveBeenCalledOnce()
      expect(owner.readMobileNativeChatDraft(scope).text).toContain('queued Q')
      if (schedule !== 'disposed') {
        expect(disk.has(key)).toBe(false)
      }
    } finally {
      release()
      await act(async () => rendered?.unmount())
      writer.dispose()
      pair.client.close()
      storage.publishMobileChatDraftStorage(null)
      owner.resetMobileNativeChatDraftStoreForTests()
      native.closeNativeChatDraftSession('ack-document')
    }
  }
)

it('acknowledges its own cleanup sentinel only while the writer remains open', async () => {
  vi.resetModules()
  const native = await import('./mobile-native-chat-draft-native-storage')
  const { createBridgeDraftWriter } =
    await import('../mobile-web-shell/bridge/bridge-draft-storage')
  for (const disposed of [false, true]) {
    const host = `sentinel-${disposed}`
    const check = native.nativeChatDraftSession(host)
    const sentinel = `orca:mobileChatDraft:${host}:workspace:`
    let release = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const writer = createBridgeDraftWriter({
      mayWrite: () => true,
      check,
      commit: native.writeNativeMobileChatDraft,
      removeWorkspace: async (h, w) => {
        await gate
        await native.removeStoredMobileChatDrafts(h, w)
      }
    })
    const result = writer.write({
      key: sentinel,
      writeId: 'cleanup',
      index: 0,
      total: 1,
      value: null
    })
    if (disposed) {
      writer.dispose()
    }
    release()
    if (disposed) {
      await expect(result).rejects.toThrow('This draft writer has ended')
    } else {
      expect(await result).toEqual({ committed: true })
    }
    expect(() => check(sentinel)).toThrow()
    writer.dispose()
    native.closeNativeChatDraftSession(host)
  }
})

it('keeps old-shell Edit and conditionally deletes only after a live complete native copy', async () => {
  vi.resetModules()
  disk.clear()
  io.beforeSet = async () => {}
  const native = await import('./mobile-native-chat-draft-native-storage')
  const { createBridgeDraftWriter } =
    await import('../mobile-web-shell/bridge/bridge-draft-storage')
  const { BRIDGE_CHAT_DRAFT_STORAGE_GRANT, storageReadParamsSchema } =
    await import('../mobile-web-shell/bridge/bridge-native-verbs')
  const check = native.nativeChatDraftSession('grant-document')
  const writer = createBridgeDraftWriter({
    mayWrite: () => true,
    check,
    commit: native.writeNativeMobileChatDraft,
    removeWorkspace: native.removeStoredMobileChatDrafts
  })
  vi.resetModules()
  const page = await import('../mobile-web-shell/bridge/page-draft-storage')
  const storage = await import('./mobile-native-chat-draft-storage')
  const owner = await import('./mobile-native-chat-draft-store')
  const { createFakeBridgePortPair } =
    await import('../mobile-web-shell/bridge/bridge-port-pair-test-harness')
  const { grantsForRoute } = await import('../mobile-web-shell/page-route-policy')
  const routes = [
    {
      pathname: '/h/[hostId]/session/[worktreeId]',
      grants: ['navigate', 'storage'],
      optionalGrants: [BRIDGE_CHAT_DRAFT_STORAGE_GRANT]
    }
  ]
  // Writer-less shells intersect declared names with their implementation, omitting this token.
  const legacy = createFakeBridgePortPair({
    routeGrants: grantsForRoute(routes, '/h/grant-host/session/workspace').filter(
      (grant) => grant !== BRIDGE_CHAT_DRAFT_STORAGE_GRANT
    )
  })
  const current = createFakeBridgePortPair({
    routeGrants: [BRIDGE_CHAT_DRAFT_STORAGE_GRANT],
    serveNativeVerb: async (verb, params) =>
      verb === 'native.storage.read'
        ? {
            value: await native.readNativeMobileChatDraft(
              storageReadParamsSchema.parse(params).key,
              check
            )
          }
        : writer.write(params)
  })
  const { createElement } = await import('react')
  const { act, create } = await import('react-test-renderer')
  const { useMobileQueuedMessageComposerActions } =
    await import('./use-mobile-queued-message-composer-actions')
  const { copyMobileQueuedMessageToDraft } = await import('./mobile-native-chat-queued-extraction')
  const { callAgentSession } = await import('./mobile-structured-agent-session-rpc')
  const { agentSessionSendBodyFingerprint } =
    await import('../../../src/shared/structured-agent-session-send-mutation')
  const scope = 'grant-host\0workspace\0tab'
  const key = 'orca:mobileChatDraft:grant-host:workspace:tab'
  const message: AgentSessionQueuedMessage = {
    messageId: 'Q',
    position: 1,
    state: 'waiting',
    body: {
      kind: 'message',
      role: 'user',
      blocks: [
        { type: 'text', text: 'copied before Delete [Image #1] $review' },
        { type: 'image-ref', url: 'https://example.com/image.png', alt: 'diagram' }
      ],
      skills: [{ name: 'review', path: '/skills/review' }]
    }
  }
  const receipts: { valid: () => boolean }[] = []
  const feedback = vi.fn()
  let actions!: ReturnType<typeof useMobileQueuedMessageComposerActions>
  function Harness() {
    actions = useMobileQueuedMessageComposerActions({
      sessionKey: scope,
      sessionId: 'chat',
      messages: [message],
      copyCapable: true,
      reorderCapable: false,
      queuedImageCards: true,
      enabled: true,
      promptPending: false,
      copyQueuedMessage: async (queued) => {
        const receipt = await copyMobileQueuedMessageToDraft(scope, queued)
        expect(receipt).not.toBe(false)
        if (receipt) {
          receipts.push(receipt)
        }
        return receipt
      },
      mutate: async <TValue>(
        method: string,
        _fingerprintMethod: string,
        fields: Record<string, unknown>
      ) => ({
        status: 'accepted',
        sameFence: true,
        value: await callAgentSession<TValue>(current.rpc, method, fields)
      }),
      onSendError: feedback
    })
    return null
  }
  let rendered: ReturnType<typeof create> | undefined
  try {
    await legacy.flush()
    page.installPageChatDraftStorage(legacy.client)
    expect(storage.mobileChatDraftStorage()).toBeNull()
    expect(legacy.readToShell().some((frame) => frame.type === 'request')).toBe(false)
    await act(async () => {
      rendered = create(createElement(Harness))
    })
    expect(actions.copyEdit).toBeUndefined()
    disk.set(key, JSON.stringify({ text: 'saved before Edit', images: [] }))
    await current.flush()
    page.installPageChatDraftStorage(current.client)
    const hydration = owner.hydrateMobileNativeChatDraft(scope)
    await current.flush()
    await hydration
    expect(owner.readMobileNativeChatDraft(scope).text).toBe('saved before Edit')
    await act(async () => {
      rendered?.update(createElement(Harness))
    })
    let edit: Promise<boolean>
    await act(async () => {
      edit = actions.copyEdit!('Q')
      await current.flush()
    })
    expect(receipts[0]?.valid()).toBe(true)
    const saved = JSON.parse(disk.get(key)!)
    expect(saved.text).toContain('saved before Edit')
    expect(saved.text).toContain('copied before Delete [Image #1] $review')
    expect(saved.images).toEqual([
      expect.objectContaining({
        reference: { url: 'https://example.com/image.png', alt: 'diagram' }
      })
    ])
    expect(saved.skills).toEqual(message.body.skills)
    expect(current.rpc.requests).toHaveLength(1)
    const deletion = current.rpc.requests[0]!
    expect(deletion.method).toBe('agentSession.queuedMessageDelete')
    expect(deletion.args[1]).toEqual({
      messageId: 'Q',
      expectedBodyFingerprint: agentSessionSendBodyFingerprint('chat', message.body)
    })
    await act(async () => {
      deletion.resolve({
        id: 'delete-Q',
        ok: true,
        result: { messageId: 'Q', deleted: true, disposition: 'deleted' }
      })
      expect(await edit).toBe(true)
    })
    expect(feedback).not.toHaveBeenCalled()
    const refusedClipboard = expect(
      current.client.callNativeVerb('native.clipboard.read', { mime: 'text' })
    ).rejects.toThrow()
    await current.flush()
    await refusedClipboard
    expect(current.rpc.requests).toEqual([deletion])
  } finally {
    await act(async () => rendered?.unmount())
    writer.dispose()
    legacy.client.close()
    current.client.close()
    storage.publishMobileChatDraftStorage(null)
    owner.resetMobileNativeChatDraftStoreForTests()
    native.closeNativeChatDraftSession('grant-document')
  }
})

it.each([false, true])(
  'reopening through an authorized route saves complete memory after native retirement (host area %s)',
  async (hostArea) => {
    vi.useFakeTimers()
    vi.resetModules()
    disk.clear()
    io.beforeSet = async () => {}
    const native = await import('./mobile-native-chat-draft-native-storage')
    const bridge = await import('../mobile-web-shell/bridge/bridge-draft-storage')
    const verbs = await import('../mobile-web-shell/bridge/bridge-native-verbs')
    const host = 'activation-host'
    const pathname = hostArea ? '/h/activation-host' : '/h/activation-host/session/workspace'
    const scope = `${host}\0workspace\0B`
    const key = `orca:mobileChatDraft:${host}:workspace:B`
    let check = native.nativeChatDraftSession('activation-old')
    const mayWrite = (key: string) => bridge.pageMayAccessChatDraft(key, host, pathname, hostArea)
    const makeWriter = () =>
      bridge.createBridgeDraftWriter({
        mayWrite,
        check,
        commit: native.writeNativeMobileChatDraft,
        removeWorkspace: native.removeStoredMobileChatDrafts
      })
    let writer = makeWriter()
    vi.resetModules()
    const page = await import('../mobile-web-shell/bridge/page-draft-storage')
    const storage = await import('./mobile-native-chat-draft-storage')
    const owner = await import('./mobile-native-chat-draft-store')
    const { useMobileNativeChatDrafts } = await import('./use-mobile-native-chat-drafts')
    const { createFakeBridgePortPair } =
      await import('../mobile-web-shell/bridge/bridge-port-pair-test-harness')
    const { createElement } = await import('react')
    const { act, create } = await import('react-test-renderer')
    let replaced = false
    let readsB = 0
    const writesB: string[] = []
    const pair = createFakeBridgePortPair({
      route: { pathname },
      pageRoutes: ['/h/[hostId]', '/h/[hostId]/session/[worktreeId]'],
      ownsHostArea: hostArea,
      routeGrants: [verbs.BRIDGE_CHAT_DRAFT_STORAGE_GRANT],
      rewriteToPage: (json) => {
        const frame = JSON.parse(json)
        if (frame.type === 'init' && replaced) {
          frame.sessionId = 'activation-new'
        }
        return JSON.stringify(frame)
      },
      serveNativeVerb: async (verb, params) => {
        if (verb === 'native.storage.read') {
          const { key } = verbs.storageReadParamsSchema.parse(params)
          expect(mayWrite(key)).toBe(true)
          if (key.endsWith(':B')) {
            readsB++
          }
          return { value: await native.readNativeMobileChatDraft(key, check) }
        }
        return writer.write(params)
      }
    })
    let model: ReturnType<typeof useMobileNativeChatDrafts> | undefined
    function Chat({ tab }: { tab: string }) {
      model = useMobileNativeChatDrafts({
        hostId: host,
        worktreeId: 'workspace',
        tabId: tab,
        sessionId: `chat-${tab}`,
        messages: [],
        transcriptSettled: true
      })
      return null
    }
    let root: ReturnType<typeof create> | undefined
    let release = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    try {
      await pair.flush()
      expect(pair.client.getShellSession()?.route?.pathname).toBe(pathname)
      page.installPageChatDraftStorage(pair.client)
      await act(async () => {
        root = create(createElement(Chat, { tab: 'B' }))
        await pair.flush()
      })
      const addition = {
        text: 'base $review $review [Image #1]',
        images: [
          {
            id: 'image',
            path: '/fixtures/image.png',
            previewUri: 'https://example.com/image.png',
            reference: { url: 'https://example.com/image.png' }
          }
        ],
        skills: [
          { name: 'review', path: '/one/SKILL.md' },
          { name: 'review', path: '/two/SKILL.md' }
        ]
      }
      const receipts: { valid(): boolean }[] = []
      await act(async () => {
        const copied = owner.appendMobileNativeChatDraft(scope, addition)
        await pair.flush()
        const receipt = await copied
        if (receipt) {
          receipts.push(receipt)
        }
      })
      expect(receipts[0]?.valid()).toBe(true)
      const oldOwner = owner.captureMobileChatDraftOwner(scope)!
      io.beforeSet = async (writeKey, value) => {
        if (writeKey === key) {
          writesB.push(JSON.parse(value).text)
          if (writesB.length === 1) {
            await gate
          }
        }
      }
      await act(async () => {
        model!.setComposerText('earlier $review $review [Image #1]')
        await vi.advanceTimersByTimeAsync(250)
        await pair.flush()
      })
      expect(writesB).toHaveLength(1)
      const oldWait = owner.persistMobileNativeChatDraft(scope).then(
        () => 'saved',
        () => 'retired'
      )
      await act(async () => {
        model!.setComposerText('newer $review $review [Image #1]')
        await vi.advanceTimersByTimeAsync(250)
      })
      const complete = owner.readMobileNativeChatDraft(scope)
      await act(async () => {
        root!.update(createElement(Chat, { tab: 'A' }))
        await pair.flush()
      })
      writer.dispose()
      native.closeNativeChatDraftSession('activation-old')
      expect(() => check(key)).toThrow()
      check = native.nativeChatDraftSession('activation-new')
      writer = makeWriter()
      replaced = true
      const ready = pair.toShell.find((json) => JSON.parse(json).type === 'ready')!
      await act(async () => {
        pair.host.receive(ready)
        await pair.flush()
        await vi.advanceTimersByTimeAsync(0)
      })
      expect(await oldWait).toBe('retired')
      expect(owner.mobileChatDraftOwnerLive(oldOwner)).toBe(false)
      expect(receipts[0]?.valid()).toBe(false)
      owner.updateMobileNativeChatDraftImages(oldOwner, () => [])
      release()
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0)
        await pair.flush()
      })
      expect(JSON.parse(disk.get(key)!).text).toBe('earlier $review $review [Image #1]')
      expect(writesB).toHaveLength(1)
      await act(async () => {
        root!.update(createElement(Chat, { tab: 'B' }))
        await pair.flush()
        await vi.advanceTimersByTimeAsync(1000)
      })
      expect(model!.composerText).toBe(complete.text)
      const { editGeneration: _generation, ...saved } = complete
      expect(JSON.parse(disk.get(key)!)).toEqual(saved)
      expect(readsB).toBe(1)
      expect(writesB).toEqual(['earlier $review $review [Image #1]', complete.text])
      await act(async () => {
        owner.mobileChatDraftLifecycle(true)
        await pair.flush()
        await vi.advanceTimersByTimeAsync(1000)
      })
      expect(writesB).toHaveLength(2)
      await act(async () => {
        root!.update(createElement(Chat, { tab: 'A' }))
        await pair.flush()
      })
      await act(async () => {
        root!.update(createElement(Chat, { tab: 'B' }))
        await pair.flush()
      })
      expect(writesB).toHaveLength(2)
      let fail = true
      io.beforeSet = async (writeKey, value) => {
        if (writeKey === key) {
          writesB.push(JSON.parse(value).text)
          if (fail) {
            throw new Error('Backing unavailable')
          }
        }
      }
      await act(async () => {
        model!.setComposerText(`${complete.text} changed`)
        await vi.advanceTimersByTimeAsync(1000)
        await pair.flush()
      })
      await act(async () => {
        root!.update(createElement(Chat, { tab: 'A' }))
        await pair.flush()
      })
      const failedAttempts = writesB.length
      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_000)
        await pair.flush()
      })
      expect(writesB).toHaveLength(failedAttempts)
      fail = false
      await act(async () => {
        root!.update(createElement(Chat, { tab: 'B' }))
        await pair.flush()
        await vi.advanceTimersByTimeAsync(30_000)
      })
      expect(writesB).toHaveLength(failedAttempts + 1)
      expect(JSON.parse(disk.get(key)!).text).toBe(`${complete.text} changed`)
      // Read the physical backing without giving a teardown flush a chance to repair it.
      await act(async () => {
        owner.resetMobileNativeChatDraftStoreForTests()
        const loaded = owner.hydrateMobileNativeChatDraft(scope)
        await pair.flush()
        await loaded
      })
      expect(owner.readMobileNativeChatDraft(scope)).toMatchObject({
        ...saved,
        text: `${complete.text} changed`
      })
    } finally {
      release()
      await act(async () => {
        root?.unmount()
        await pair.flush()
      })
      pair.client.close()
      writer.dispose()
      storage.publishMobileChatDraftStorage(null)
      owner.resetMobileNativeChatDraftStoreForTests()
      native.closeNativeChatDraftSession('activation-new')
      vi.useRealTimers()
      io.beforeSet = async () => {}
    }
  }
)
