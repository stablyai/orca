import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { OmpRpcChatEventPayload } from '../../shared/omp-rpc-chat-ipc-contract'
import type { OmpRpcClientEvent } from '../../shared/omp-rpc-protocol'

const {
  handle,
  on,
  appOnce,
  getAllWebContents,
  registryInstance,
  RegistryCtor,
  resolveOmpRpcLaunch,
  resolveSessionFilePath,
  resolveOmpPaneSessionIdentity,
  hasOtherLocalOmpRpcPtySessionWriter,
  localOmpRpcPtyProvider,
  isLocalOmpRpcPtyAlive,
  localOmpRpcPtySlavePath
} = vi.hoisted(() => {
  const registryInstance = {
    acquire: vi.fn(),
    release: vi.fn(),
    get: vi.fn(),
    getSessionFile: vi.fn(),
    disposeAll: vi.fn(),
    claimedSessionFilePathsExcluding: vi.fn(() => new Set<string>())
  }
  return {
    handle: vi.fn(),
    on: vi.fn(),
    appOnce: vi.fn(),
    getAllWebContents: vi.fn(() => [] as unknown[]),
    registryInstance,
    RegistryCtor: vi.fn(function OmpRpcChatSessionRegistry() {
      return registryInstance
    }),
    resolveOmpRpcLaunch: vi.fn(),
    resolveSessionFilePath: vi.fn(),
    resolveOmpPaneSessionIdentity: vi.fn(),
    hasOtherLocalOmpRpcPtySessionWriter: vi.fn(),
    localOmpRpcPtyProvider: vi.fn(),
    isLocalOmpRpcPtyAlive: vi.fn(),
    localOmpRpcPtySlavePath: vi.fn()
  }
})

vi.mock('electron', () => ({
  ipcMain: { handle, on },
  app: { once: appOnce },
  // The hand-back is broadcast to every live renderer and retained for a later
  // claim (XLR-R7-001), so this is the surface those tests observe — not the
  // requesting sender.
  webContents: { getAllWebContents }
}))
vi.mock('../omp-rpc/omp-rpc-chat-session-registry', () => ({
  OmpRpcChatSessionRegistry: RegistryCtor
}))
vi.mock('./omp-rpc', () => ({ resolveOmpRpcLaunch }))
vi.mock('../native-chat/session-file-resolver', () => ({ resolveSessionFilePath }))
vi.mock('../native-chat/omp-terminal-session-identity', () => ({ resolveOmpPaneSessionIdentity }))
// Why: no real PTY provider is ever registered for a bare 'pty-N' test id —
// the resolveSessionIdentity locality gate (finding E) would otherwise
// reject every test call as "not local" regardless of intent. Defaults
// truthy in beforeEach; the dedicated locality-gate test overrides it.
vi.mock('../omp-rpc/omp-rpc-local-pty-access', () => ({
  hasOtherLocalOmpRpcPtySessionWriter,
  localOmpRpcPtyProvider,
  isLocalOmpRpcPtyAlive,
  localOmpRpcPtySlavePath
}))

import {
  clearOmpRpcChatHandlersForTests,
  registerOmpRpcChatHandlers,
  shutdownOmpRpcChatSessions
} from './omp-rpc-chat'

const HANDBACK_LEAF_ID = '11111111-1111-4111-8111-111111111111'

/** `senderId` stands in for the claiming `webContents`, which the hand-back
 *  lease keys on (XLR-R8-001). */
function invoke(channel: string, args?: unknown, senderId = 1): Promise<unknown> {
  const handler = handle.mock.calls.find(([name]) => name === channel)?.[1] as (
    event: unknown,
    args?: unknown
  ) => Promise<unknown>
  return handler({ sender: { id: senderId } }, args)
}

/** A live renderer for the hand-back broadcast to reach. */
function makeRenderer(): { isDestroyed: () => boolean; send: ReturnType<typeof vi.fn> } {
  const renderer = { isDestroyed: () => false, send: vi.fn() }
  getAllWebContents.mockReturnValue([renderer])
  return renderer
}

function fireOn(channel: string, event: unknown, args?: unknown): void {
  const handler = on.mock.calls.find(([name]) => name === channel)?.[1] as (
    event: unknown,
    args?: unknown
  ) => void
  handler(event, args)
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

describe('OMP RPC chat IPC handlers', () => {
  beforeEach(() => {
    clearOmpRpcChatHandlersForTests()
    vi.clearAllMocks()
    resolveOmpRpcLaunch.mockResolvedValue({ executablePath: '/usr/local/bin/omp' })
    resolveSessionFilePath.mockResolvedValue('/sessions/a.jsonl')
    resolveOmpPaneSessionIdentity.mockResolvedValue(null)
    hasOtherLocalOmpRpcPtySessionWriter.mockResolvedValue(false)
    localOmpRpcPtyProvider.mockReturnValue({})
    // No registered session unless a test says so: a refused release now arms a
    // settlement continuation against whatever `get` reports (XLR-R6-003), and
    // `clearAllMocks` keeps a previous test's return value.
    registryInstance.get.mockReturnValue(null)
    getAllWebContents.mockReturnValue([])
  })

  it('registers resolveSessionIdentity/acquire/release/fetchHistory/send/abort/respond and the subscribe push channels', () => {
    registerOmpRpcChatHandlers()
    expect(handle.mock.calls.map(([channel]) => channel)).toEqual([
      'ompRpcChat:resolveSessionIdentity',
      'ompRpcChat:acquire',
      'ompRpcChat:hasSession',
      'ompRpcChat:release',
      'ompRpcChat:claimPendingHandbacks',
      'ompRpcChat:settleHandback',
      'ompRpcChat:fetchHistory',
      'ompRpcChat:send',
      'ompRpcChat:abort',
      'ompRpcChat:respondExtensionUi'
    ])
    expect(on.mock.calls.map(([channel]) => channel)).toEqual([
      'ompRpcChat:subscribe',
      'ompRpcChat:unsubscribe'
    ])
    // Quit teardown is no longer a listener of this module's own: it is exposed
    // as a promise src/main/index.ts joins into the will-quit barrier, so
    // `app.quit()` cannot beat the RPC children's exits (XLR-R6-005).
    expect(appOnce).not.toHaveBeenCalled()
  })

  // XLR-R6-004: main's registry is the only authoritative session identity after reload.
  it('returns main authoritative session identity for a surviving pane session', async () => {
    registerOmpRpcChatHandlers()
    const hasSession = handle.mock.calls.find(
      ([channel]) => channel === 'ompRpcChat:hasSession'
    )?.[1]
    registryInstance.getSessionFile.mockReturnValue('session-a')
    expect(hasSession({}, { paneKey: 'tab:leaf' })).toEqual({ sessionFile: 'session-a' })
    registryInstance.getSessionFile.mockReturnValue(null)
    expect(hasSession({}, { paneKey: 'tab:leaf' })).toBeNull()
    expect(hasSession({}, { paneKey: '  ' })).toBeNull()
  })

  it('exposes quit teardown as an awaitable that disposes a live registry (XLR-R6-005)', async () => {
    registryInstance.release.mockResolvedValue({ released: true })
    registerOmpRpcChatHandlers()
    // Any handler call is what instantiates the registry this must tear down.
    await handle.mock.calls.find(([channel]) => channel === 'ompRpcChat:release')?.[1](
      { sender: { isDestroyed: () => true, send: vi.fn() } },
      { paneKey: 'tab:leaf' }
    )
    await expect(shutdownOmpRpcChatSessions()).resolves.toBeUndefined()
    expect(registryInstance.disposeAll).toHaveBeenCalledTimes(1)
  })

  it('waits for executable resolution before completing shutdown and refuses the late acquire', async () => {
    const executable = deferred<string | null>()
    resolveOmpRpcLaunch.mockReturnValue(executable.promise)
    registerOmpRpcChatHandlers()
    const acquire = invoke('ompRpcChat:acquire', {
      paneKey: 'tab:leaf',
      ptyId: 'pty-1',
      cwd: '/work',
      sessionFile: 'session-1'
    })
    const shutdown = shutdownOmpRpcChatSessions()

    executable.resolve('/usr/local/bin/omp')

    await expect(shutdown).resolves.toBeUndefined()
    await expect(acquire).resolves.toEqual({ ok: false, reason: 'spawn-failed' })
    expect(registryInstance.acquire).not.toHaveBeenCalled()
  })

  it('resolveSessionIdentity returns the resolved session, threading paneKey/ptyId/cwd through', async () => {
    resolveOmpPaneSessionIdentity.mockResolvedValue({
      sessionId: 'session-1',
      sessionFilePath: '/sessions/session-1.jsonl',
      source: 'breadcrumb'
    })
    registryInstance.claimedSessionFilePathsExcluding.mockReturnValue(new Set(['/other.jsonl']))
    registerOmpRpcChatHandlers()
    await expect(
      invoke('ompRpcChat:resolveSessionIdentity', {
        paneKey: 'tab-1:leaf-1',
        ptyId: 'pty-1',
        cwd: '/work'
      })
    ).resolves.toEqual({ sessionId: 'session-1', source: 'breadcrumb' })
    expect(resolveOmpPaneSessionIdentity).toHaveBeenCalledWith(
      { ptyId: 'pty-1', cwd: '/work' },
      expect.objectContaining({
        getSlavePath: expect.any(Function),
        claimedSessionFilePaths: new Set(['/other.jsonl'])
      })
    )
    expect(registryInstance.claimedSessionFilePathsExcluding).toHaveBeenCalledWith('tab-1:leaf-1')
  })

  // Wave 9, Defect 1: `ptyId` is an optional accuracy input, not a
  // precondition — Decision 1's acquisition kills the pane's live PTY on
  // success, so a null `ptyId` must still resolve via the mtime fallback
  // instead of being rejected the way a missing `paneKey`/`cwd` is.
  it('resolveSessionIdentity resolves with a null ptyId, skipping the locality gate', async () => {
    resolveOmpPaneSessionIdentity.mockResolvedValue({
      sessionId: 'session-2',
      sessionFilePath: '/sessions/session-2.jsonl',
      source: 'mtime-fallback'
    })
    registerOmpRpcChatHandlers()
    await expect(
      invoke('ompRpcChat:resolveSessionIdentity', {
        paneKey: 'tab-1:leaf-1',
        ptyId: null,
        cwd: '/work'
      })
    ).resolves.toEqual({ sessionId: 'session-2', source: 'mtime-fallback' })
    expect(localOmpRpcPtyProvider).not.toHaveBeenCalled()
    expect(resolveOmpPaneSessionIdentity).toHaveBeenCalledWith(
      { ptyId: null, cwd: '/work' },
      expect.objectContaining({ getSlavePath: expect.any(Function) })
    )
  })

  // Finding E (cross-lab review, wave 5): the mtime-fallback sub-path has
  // no independent locality gate of its own — verify it here rather than
  // trust the renderer's own `runtimeEnvironmentId === null` gate alone.
  it('resolveSessionIdentity fails closed to null for a non-local ptyId without resolving', async () => {
    localOmpRpcPtyProvider.mockReturnValue(null)
    registerOmpRpcChatHandlers()
    await expect(
      invoke('ompRpcChat:resolveSessionIdentity', {
        paneKey: 'tab-1:leaf-1',
        ptyId: 'pty-1',
        cwd: '/work'
      })
    ).resolves.toBeNull()
    expect(resolveOmpPaneSessionIdentity).not.toHaveBeenCalled()
  })

  it('resolveSessionIdentity returns null on a missing paneKey without resolving', async () => {
    registerOmpRpcChatHandlers()
    await expect(
      invoke('ompRpcChat:resolveSessionIdentity', { paneKey: '', ptyId: 'pty-1', cwd: '/work' })
    ).resolves.toBeNull()
    expect(resolveOmpPaneSessionIdentity).not.toHaveBeenCalled()
  })

  it('resolveSessionIdentity returns null on a missing cwd without resolving', async () => {
    registerOmpRpcChatHandlers()
    await expect(
      invoke('ompRpcChat:resolveSessionIdentity', {
        paneKey: 'tab-1:leaf-1',
        ptyId: 'pty-1',
        cwd: ''
      })
    ).resolves.toBeNull()
    expect(resolveOmpPaneSessionIdentity).not.toHaveBeenCalled()
  })

  it('resolveSessionIdentity fails closed to null when the resolver throws', async () => {
    resolveOmpPaneSessionIdentity.mockRejectedValue(new Error('disk error'))
    registerOmpRpcChatHandlers()
    await expect(
      invoke('ompRpcChat:resolveSessionIdentity', {
        paneKey: 'tab-1:leaf-1',
        ptyId: 'pty-1',
        cwd: '/work'
      })
    ).resolves.toBeNull()
  })

  it('fails closed with executable-not-found when omp cannot be resolved', async () => {
    resolveOmpRpcLaunch.mockResolvedValue(null)
    registerOmpRpcChatHandlers()
    await expect(
      invoke('ompRpcChat:acquire', {
        paneKey: 'tab:leaf',
        ptyId: 'pty-1',
        cwd: '/work',
        sessionFile: '/sessions/a.jsonl'
      })
    ).resolves.toEqual({ ok: false, reason: 'executable-not-found' })
    expect(registryInstance.acquire).not.toHaveBeenCalled()
  })

  it('resolves the configured OMP launch command for an acquired pane', async () => {
    resolveOmpRpcLaunch.mockResolvedValue({
      executablePath: '/opt/omp-v2/bin/omp',
      commandArgs: ['--protocol', 'v2']
    })
    registryInstance.acquire.mockResolvedValue({ status: 'acquired', session: {} })
    registerOmpRpcChatHandlers()

    await expect(
      invoke('ompRpcChat:acquire', {
        paneKey: 'tab:leaf',
        ptyId: 'pty-1',
        cwd: '/work',
        sessionFile: 'session-1',
        agentCommand: '"/opt/omp-v2/bin/omp" --protocol v2'
      })
    ).resolves.toEqual({ ok: true })

    expect(resolveOmpRpcLaunch).toHaveBeenCalledWith('"/opt/omp-v2/bin/omp" --protocol v2')
    expect(registryInstance.acquire).toHaveBeenCalledWith(
        expect.objectContaining({
          executablePath: '/opt/omp-v2/bin/omp',
          commandArgs: ['--protocol', 'v2']
        })
    )
  })

  it('fails closed on missing required args without resolving the executable', async () => {
    registerOmpRpcChatHandlers()
    await expect(
      invoke('ompRpcChat:acquire', { paneKey: '', ptyId: '', cwd: '', sessionFile: '' })
    ).resolves.toEqual({ ok: false, reason: 'spawn-failed' })
    expect(resolveOmpRpcLaunch).not.toHaveBeenCalled()
  })

  it('maps a successful acquisition to ok:true', async () => {
    registryInstance.acquire.mockResolvedValue({ status: 'acquired', session: {} })
    registerOmpRpcChatHandlers()
    await expect(
      invoke('ompRpcChat:acquire', {
        paneKey: 'tab:leaf',
        ptyId: 'pty-1',
        cwd: '/work',
        sessionFile: 'session-id-1'
      })
    ).resolves.toEqual({ ok: true })
    expect(resolveSessionFilePath).toHaveBeenCalledWith('omp', 'session-id-1')
    expect(registryInstance.acquire).toHaveBeenCalledWith(
      expect.objectContaining({
        paneKey: 'tab:leaf',
        ptyId: 'pty-1',
        executablePath: '/usr/local/bin/omp',
        sessionFile: 'session-id-1',
        sessionFilePath: '/sessions/a.jsonl'
      })
    )
  })

  it('supplies a fail-closed competing-local-PTY proof before acquisition', async () => {
    hasOtherLocalOmpRpcPtySessionWriter.mockResolvedValue(true)
    registryInstance.acquire.mockResolvedValue({ status: 'conflict' })
    registerOmpRpcChatHandlers()

    await expect(
      invoke('ompRpcChat:acquire', {
        paneKey: 'tab:first',
        ptyId: 'pty-first',
        cwd: '/work',
        sessionFile: 'session-id-1'
      })
    ).resolves.toEqual({ ok: false, reason: 'conflict' })

    const proof = registryInstance.acquire.mock.calls[0]?.[0]?.hasOtherPtySessionWriter as (
      sessionFilePath: string,
      ptyId: string
    ) => Promise<boolean>
    await expect(proof('/sessions/a.jsonl', 'pty-first')).resolves.toBe(true)
    expect(hasOtherLocalOmpRpcPtySessionWriter).toHaveBeenCalledWith(
      '/sessions/a.jsonl',
      'pty-first'
    )
  })

  // F12: switch_session requires the resolved absolute path, not the bare id
  // — acquisition must fail closed rather than pass the id through unresolved.
  it('fails closed when the bare session id cannot be resolved to a file path', async () => {
    resolveSessionFilePath.mockResolvedValue(null)
    registerOmpRpcChatHandlers()
    await expect(
      invoke('ompRpcChat:acquire', {
        paneKey: 'tab:leaf',
        ptyId: 'pty-1',
        cwd: '/work',
        sessionFile: 'session-id-1'
      })
    ).resolves.toEqual({ ok: false, reason: 'spawn-failed' })
    expect(registryInstance.acquire).not.toHaveBeenCalled()
  })

  // XLR-045 (cross-lab review): `rpc-child-unverifiable` owes the pane neither
  // a respawn nor the pre-kill undo, and the renderer never acquired — so it
  // fires no release, and nothing else would ever ask for the PTY acquisition
  // killed. The registry's late-exit signal is the pane's only way back, and it
  // has to reach the same durable hand-back listener a settled release uses.
  it("pushes a handback once a failed acquisition's child exits (XLR-045)", async () => {
    registryInstance.acquire.mockResolvedValue({
      status: 'rpc-child-unverifiable',
      reason: 'child exit unproven'
    })
    registerOmpRpcChatHandlers()
    const renderer = makeRenderer()
    await expect(
      invoke('ompRpcChat:acquire', {
        paneKey: 'tab:leaf',
        ptyId: 'pty-1',
        cwd: '/work',
        sessionFile: 'session-1'
      })
    ).resolves.toEqual({ ok: false, reason: 'rpc-child-unverifiable' })
    expect(renderer.send).not.toHaveBeenCalled()

    registryInstance.acquire.mock.calls[0]?.[0]?.onLateRpcChildExit?.()

    expect(renderer.send).toHaveBeenCalledWith('ompRpcChat:handback', {
      paneKey: 'tab:leaf',
      replacedPtyId: 'pty-1',
      cwd: '/work',
      sessionId: 'session-1'
    })
  })

  it('maps a live-pty refusal to ok:false reason "live"', async () => {
    registryInstance.acquire.mockResolvedValue({ status: 'live' })
    registerOmpRpcChatHandlers()
    await expect(
      invoke('ompRpcChat:acquire', {
        paneKey: 'tab:leaf',
        ptyId: 'pty-1',
        cwd: '/work',
        sessionFile: '/sessions/a.jsonl'
      })
    ).resolves.toEqual({ ok: false, reason: 'live' })
  })

  it('routes send/abort/respondExtensionUi to the pane session, failing closed when unacquired', async () => {
    registerOmpRpcChatHandlers()
    registryInstance.get.mockReturnValue(null)
    await expect(
      invoke('ompRpcChat:send', { paneKey: 'tab:leaf', message: 'hi', behavior: 'idle' })
    ).resolves.toEqual({ ok: false, reason: expect.any(String) })
    await expect(invoke('ompRpcChat:abort', { paneKey: 'tab:leaf' })).resolves.toEqual({
      ok: false,
      reason: expect.any(String)
    })
    await expect(
      invoke('ompRpcChat:respondExtensionUi', {
        paneKey: 'tab:leaf',
        response: { type: 'extension_ui_response', id: 'x', confirmed: true }
      })
    ).resolves.toBe(false)

    const session = {
      send: vi.fn().mockResolvedValue({ ok: true, agentInvoked: true }),
      abort: vi.fn().mockResolvedValue({ ok: true, agentInvoked: true }),
      respondExtensionUi: vi.fn().mockReturnValue(true)
    }
    registryInstance.get.mockReturnValue(session)
    await expect(
      invoke('ompRpcChat:send', { paneKey: 'tab:leaf', message: 'hi', behavior: 'steer' })
    ).resolves.toEqual({ ok: true, agentInvoked: true })
    expect(session.send).toHaveBeenCalledWith({
      message: 'hi',
      images: undefined,
      behavior: 'steer'
    })
    await expect(invoke('ompRpcChat:abort', { paneKey: 'tab:leaf' })).resolves.toEqual({
      ok: true,
      agentInvoked: true
    })
    await expect(
      invoke('ompRpcChat:respondExtensionUi', {
        paneKey: 'tab:leaf',
        response: { type: 'extension_ui_response', id: 'x', confirmed: true }
      })
    ).resolves.toBe(true)
  })

  it('routes fetchHistory to the pane session, failing closed when unacquired', async () => {
    registerOmpRpcChatHandlers()
    registryInstance.get.mockReturnValue(null)
    // D1: a pane with no owned session degrades to its transcript rather than
    // throwing across the boundary, and `unavailable` is what says so.
    await expect(invoke('ompRpcChat:fetchHistory', { paneKey: 'tab:leaf' })).resolves.toEqual({
      ok: false,
      reason: 'unavailable'
    })

    const session = {
      fetchHistory: vi.fn().mockResolvedValue({ ok: true, messages: [], totalMessages: 0 })
    }
    registryInstance.get.mockReturnValue(session)
    await expect(
      invoke('ompRpcChat:fetchHistory', { paneKey: 'tab:leaf', limit: 64 })
    ).resolves.toEqual({ ok: true, messages: [], totalMessages: 0 })
    expect(session.fetchHistory).toHaveBeenCalledWith({ limit: 64 })

    // An omitted limit stays omitted rather than becoming an explicit
    // undefined, so the drain uses OMP's own default page size.
    await invoke('ompRpcChat:fetchHistory', { paneKey: 'tab:leaf' })
    expect(session.fetchHistory).toHaveBeenLastCalledWith({})
  })

  it('releases and reports the registry result', async () => {
    registryInstance.release.mockResolvedValue({ released: true })
    registerOmpRpcChatHandlers()
    await expect(invoke('ompRpcChat:release', { paneKey: 'tab:leaf' })).resolves.toEqual({
      released: true
    })
    expect(registryInstance.release).toHaveBeenCalledWith('tab:leaf')
  })

  // Critical B (cross-lab review, wave 5): only a release that genuinely
  // settled and exited hands the pane back. The renderer's own respawn context
  // carries the pane back, except for the session identity when main proved a
  // different one (XLR-019, next test).
  it('pushes a handback event to every live renderer when a respawn-intent release settles', async () => {
    registryInstance.release.mockResolvedValue({ released: true })
    registerOmpRpcChatHandlers()
    const renderer = makeRenderer()
    await expect(
      invoke('ompRpcChat:release', {
        paneKey: 'tab:leaf',
        respawn: { replacedPtyId: 'pty-1', cwd: '/work', sessionId: 'session-1' }
      })
    ).resolves.toEqual({ released: true })
    expect(renderer.send).toHaveBeenCalledWith('ompRpcChat:handback', {
      paneKey: 'tab:leaf',
      replacedPtyId: 'pty-1',
      cwd: '/work',
      sessionId: 'session-1'
    })
  })

  // XLR-019 (cross-lab review): a supported command can switch the child from
  // the session the renderer acquired to another one. `handoffToPty` reads and
  // validates the live identity before disposing, so main's is the only proven
  // one — echoing the renderer's would resume `omp --resume <old>` and silently
  // abandon the conversation that was active when the release completed.
  it('hands back the session identity main proved, not the renderer acquisition-time id', async () => {
    registryInstance.release.mockResolvedValue({ released: true, sessionId: 'session-b' })
    registerOmpRpcChatHandlers()
    const renderer = makeRenderer()
    await expect(
      invoke('ompRpcChat:release', {
        paneKey: 'tab:leaf',
        respawn: { replacedPtyId: 'pty-1', cwd: '/work', sessionId: 'session-a' }
      })
    ).resolves.toEqual({ released: true })
    expect(renderer.send).toHaveBeenCalledWith('ompRpcChat:handback', {
      paneKey: 'tab:leaf',
      replacedPtyId: 'pty-1',
      cwd: '/work',
      sessionId: 'session-b'
    })
  })

  it('never pushes a handback event when the release fails closed (keeps the claim)', async () => {
    registryInstance.release.mockResolvedValue({ released: false })
    registerOmpRpcChatHandlers()
    const renderer = makeRenderer()
    await expect(
      invoke('ompRpcChat:release', {
        paneKey: 'tab:leaf',
        respawn: { replacedPtyId: 'pty-1', cwd: '/work', sessionId: 'session-1' }
      })
    ).resolves.toEqual({ released: false })
    expect(renderer.send).not.toHaveBeenCalled()
  })

  // XLR-R7-001 (cross-lab review): a settled release deleted the RPC session, so
  // the pane's adoption probe now answers "no session". If the hand-back push
  // also reached nobody — the requesting renderer reloaded or closed while the
  // bounded release was still proving settle+exit — the pane would be left with
  // neither RPC ownership nor a PTY, permanently. The instruction is retained
  // for the next durable listener to claim instead.
  it('retains the handback for a later claim when no renderer could receive the push', async () => {
    registryInstance.release.mockResolvedValue({ released: true })
    registerOmpRpcChatHandlers()
    const destroyed = { isDestroyed: () => true, send: vi.fn() }
    getAllWebContents.mockReturnValue([destroyed])
    const paneKey = `tab-1:${HANDBACK_LEAF_ID}`

    await expect(
      invoke('ompRpcChat:release', {
        paneKey,
        respawn: { replacedPtyId: 'pty-1', cwd: '/work', sessionId: 'session-1' }
      })
    ).resolves.toEqual({ released: true })
    expect(destroyed.send).not.toHaveBeenCalled()

    // The reloaded renderer's TerminalPane claims on mount. The claim LEASES it
    // to that renderer (XLR-R8-001), so no second claimant can respawn a second
    // PTY beside the one it is already starting.
    getAllWebContents.mockReturnValue([{ id: 1, isDestroyed: () => false, send: vi.fn() }])
    const claimed = (await invoke('ompRpcChat:claimPendingHandbacks', {
      tabId: 'tab-1',
      claimantDocumentId: 'document-1'
    })) as {
      token: string
      payload: unknown
    }[]
    expect(claimed).toEqual([
      {
        token: expect.any(String),
        payload: { paneKey, replacedPtyId: 'pty-1', cwd: '/work', sessionId: 'session-1' }
      }
    ])
    expect(
      await invoke(
        'ompRpcChat:claimPendingHandbacks',
        { tabId: 'tab-1', claimantDocumentId: 'document-2' },
        2
      )
    ).toEqual([])
    expect(
      await invoke('ompRpcChat:claimPendingHandbacks', { tabId: '  ', claimantDocumentId: 'd' })
    ).toEqual([])
    // Fail closed without a document id (XLR-R9-001): the `webContents` id
    // alone cannot tell a reload from the holder claiming again mid-respawn.
    expect(await invoke('ompRpcChat:claimPendingHandbacks', { tabId: 'tab-1' })).toEqual([])

    // Nothing has proven a respawn yet, so a failed one must leave the pane
    // recoverable rather than dropping its only instruction.
    await invoke('ompRpcChat:settleHandback', {
      paneKey,
      token: claimed[0].token,
      respawned: false
    })
    const reclaimed = (await invoke(
      'ompRpcChat:claimPendingHandbacks',
      { tabId: 'tab-1', claimantDocumentId: 'document-2' },
      2
    )) as {
      token: string
    }[]
    expect(reclaimed).toHaveLength(1)

    await invoke('ompRpcChat:settleHandback', {
      paneKey,
      token: reclaimed[0].token,
      respawned: true
    })
    expect(
      await invoke(
        'ompRpcChat:claimPendingHandbacks',
        { tabId: 'tab-1', claimantDocumentId: 'document-3' },
        3
      )
    ).toEqual([])
  })

  it('forwards session events to the subscribing sender only for its subscriptionId', () => {
    const emittedListeners: ((event: OmpRpcClientEvent) => void)[] = []
    const session = {
      on: vi.fn((listener: (event: OmpRpcClientEvent) => void) => {
        emittedListeners.push(listener)
        return vi.fn()
      })
    }
    registryInstance.get.mockReturnValue(session)
    registerOmpRpcChatHandlers()
    const send = vi.fn()
    const sender = { id: 7, isDestroyed: () => false, send, once: vi.fn() }
    fireOn('ompRpcChat:subscribe', { sender }, { paneKey: 'tab:leaf', subscriptionId: 'sub-1' })
    expect(emittedListeners).toHaveLength(1)

    const event: OmpRpcClientEvent = { kind: 'agent-start', frame: { type: 'agent_start' } }
    emittedListeners[0](event)
    expect(send).toHaveBeenCalledWith('ompRpcChat:event', {
      subscriptionId: 'sub-1',
      event
    } satisfies OmpRpcChatEventPayload)
  })

  it('unsubscribes cleanly and tears down all subscriptions when the sender is destroyed', () => {
    const unsubscribe = vi.fn()
    const session = { on: vi.fn(() => unsubscribe) }
    registryInstance.get.mockReturnValue(session)
    registerOmpRpcChatHandlers()
    let destroyedHandler: (() => void) | undefined
    const sender = {
      id: 9,
      isDestroyed: () => false,
      send: vi.fn(),
      once: vi.fn((eventName: string, handler: () => void) => {
        if (eventName === 'destroyed') {
          destroyedHandler = handler
        }
      })
    }
    fireOn('ompRpcChat:subscribe', { sender }, { paneKey: 'tab:leaf', subscriptionId: 'sub-1' })
    fireOn('ompRpcChat:unsubscribe', { sender }, { subscriptionId: 'sub-1' })
    expect(unsubscribe).toHaveBeenCalledTimes(1)

    fireOn('ompRpcChat:subscribe', { sender }, { paneKey: 'tab:leaf', subscriptionId: 'sub-2' })
    destroyedHandler?.()
    expect(unsubscribe).toHaveBeenCalledTimes(2)
  })

  it('no-ops a subscribe for a pane with no acquired session', () => {
    registryInstance.get.mockReturnValue(null)
    registerOmpRpcChatHandlers()
    const send = vi.fn()
    const sender = { id: 3, isDestroyed: () => false, send, once: vi.fn() }
    expect(() =>
      fireOn('ompRpcChat:subscribe', { sender }, { paneKey: 'tab:leaf', subscriptionId: 'sub-1' })
    ).not.toThrow()
    expect(send).not.toHaveBeenCalled()
  })
})
