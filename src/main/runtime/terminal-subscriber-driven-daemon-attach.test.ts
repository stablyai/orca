/**
 * Subscriber-driven daemon attach (never-activated tab ingestion).
 *
 * Invariant: on a remote-server host, a daemon-backed terminal whose tab was
 * never activated in the host UI must still stream to paired clients and be
 * readable via `terminal read`. The daemon only emits data for sessions this
 * app has ATTACHED, and attach historically happened only via renderer pane
 * mount — so a never-activated tab produced blank paired panes and empty CLI
 * tails while the PTY was alive.
 *
 * Harness: real OrcaRuntimeService + real TERMINAL_METHODS multiplex handler,
 * with an injected pty controller modeling a daemon provider whose data events
 * are deliverable ONLY after attach(id). No window is ever attached — every
 * assertion also holds for headless `orca serve`.
 */
import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import { RpcDispatcher } from './rpc/dispatcher'
import type { RpcRequest } from './rpc/core'
import { TERMINAL_METHODS } from './rpc/methods/terminal'
import {
  TerminalStreamOpcode,
  decodeTerminalStreamFrame,
  decodeTerminalStreamText,
  encodeTerminalStreamFrame,
  encodeTerminalStreamJson
} from '../../shared/terminal-stream-protocol'

const WORKTREE_ID = 'repo-1::/tmp/wt'
const PTY_ID = `${WORKTREE_ID}@@1a2b3c4d`

type RuntimeInternals = {
  recordPtyWorktree: (
    ptyId: string,
    worktreeId: string,
    state?: { connected?: boolean; connectionId?: string | null }
  ) => unknown
  issuePtyHandle: (pty: unknown) => string
  headlessTerminals: Map<string, unknown>
  terminalViewSubscribers: {
    hasPendingProviderAttach: (ptyId: string) => boolean
    attachInventoryWaiterIds: () => string[]
  }
  refreshPtyWorktreeRecordsWithControllerInventory: (
    worktrees: [],
    targetWorktreeId: string | null
  ) => Promise<unknown>
}

function internals(runtime: OrcaRuntimeService): RuntimeInternals {
  return runtime as unknown as RuntimeInternals
}

type DaemonSessionModel = {
  cols: number
  rows: number
  attached: boolean
  screen: string
}

/** Models the daemon provider boundary: inventory of live sessions, data
 *  events gated on attach, and a configurable authoritative snapshot. */
function createDaemonProviderModel(opts: { snapshotCapable: boolean }) {
  const sessions = new Map<string, DaemonSessionModel>()
  const attachCalls: string[] = []
  const resizeCalls: [string, number, number][] = []
  let nextAttachBarrier: { promise: Promise<void>; result: boolean } | null = null
  let runtime: OrcaRuntimeService | null = null
  const controller = {
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null,
    listProcesses: async () =>
      [...sessions.entries()].map(([id, session]) => ({
        id,
        cwd: '/tmp/wt',
        worktreeId: WORKTREE_ID,
        title: '',
        cols: session.cols,
        rows: session.rows
      })),
    hasRendererSerializer: () => false,
    getSize: (ptyId: string) => {
      const session = sessions.get(ptyId)
      return session ? { cols: session.cols, rows: session.rows } : null
    },
    resize: (ptyId: string, cols: number, rows: number) => {
      resizeCalls.push([ptyId, cols, rows])
      return true
    },
    attach: async (ptyId: string) => {
      attachCalls.push(ptyId)
      const barrier = nextAttachBarrier
      nextAttachBarrier = null
      if (barrier) {
        await barrier.promise
        if (!barrier.result) {
          return false
        }
      }
      const session = sessions.get(ptyId)
      // Attach-only: an absent session is refused, never created.
      if (!session) {
        return false
      }
      session.attached = true
      return true
    },
    serializeProviderBuffer: async (ptyId: string) => {
      const session = sessions.get(ptyId)
      if (!session || !opts.snapshotCapable) {
        // v19-style daemon: no authoritative snapshot (missing outputSequence).
        return null
      }
      return {
        data: session.screen,
        cols: session.cols,
        rows: session.rows,
        seq: 0,
        source: 'headless' as const
      }
    }
  }
  return {
    controller,
    sessions,
    attachCalls,
    resizeCalls,
    deferNextAttach(result: boolean): () => void {
      let release!: () => void
      const promise = new Promise<void>((resolve) => {
        release = resolve
      })
      nextAttachBarrier = { promise, result }
      return release
    },
    bind(target: OrcaRuntimeService) {
      runtime = target
    },
    /** Daemon stream event → main ingestion, exactly like ipc/pty.ts wiring —
     *  but the daemon only emits for sessions this app has attached. */
    emitData(ptyId: string, data: string): boolean {
      const session = sessions.get(ptyId)
      if (!session?.attached) {
        return false
      }
      runtime?.onPtyData(ptyId, data, Date.now())
      return true
    }
  }
}

function setupNeverAttachedDaemonSession(opts: { snapshotCapable: boolean; screen?: string }): {
  runtime: OrcaRuntimeService
  model: ReturnType<typeof createDaemonProviderModel>
  handle: string
  mountSpy: ReturnType<typeof vi.spyOn>
} {
  const runtime = new OrcaRuntimeService()
  const model = createDaemonProviderModel(opts)
  model.bind(runtime)
  runtime.setPtyController(model.controller as never)
  model.sessions.set(PTY_ID, {
    cols: 137,
    rows: 41,
    attached: false,
    screen: opts.screen ?? 'agent frozen screen\r\n'
  })
  // Same record + synthetic pty-form handle minting session.tabs.list uses
  // (controller inventory → recordPtyWorktree → issuePtyHandle).
  const record = internals(runtime).recordPtyWorktree(PTY_ID, WORKTREE_ID, { connected: true })
  const handle = internals(runtime).issuePtyHandle(record)
  const mountSpy = vi.spyOn(runtime, 'requestRendererTerminalTabMount')
  return { runtime, model, handle, mountSpy }
}

function startMultiplex(runtime: OrcaRuntimeService, connectionId = 'conn-desktop') {
  const messages: { result?: { type?: string; streamId?: number | null } }[] = []
  const binaryFrames: Uint8Array<ArrayBufferLike>[] = []
  const handlers = new Map<
    number,
    (frame: NonNullable<ReturnType<typeof decodeTerminalStreamFrame>>) => void
  >()
  const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })
  const request: RpcRequest = {
    id: 'req-1',
    authToken: 'tok',
    method: 'terminal.multiplex',
    params: {}
  }
  const dispatchPromise = dispatcher.dispatchStreaming(
    request,
    (msg) => {
      messages.push(JSON.parse(msg))
    },
    {
      connectionId,
      sendBinary: (bytes: Uint8Array<ArrayBufferLike>) => {
        binaryFrames.push(bytes)
        return true
      },
      registerBinaryStreamHandler: (
        streamId: number,
        handler: (frame: NonNullable<ReturnType<typeof decodeTerminalStreamFrame>>) => void
      ) => {
        handlers.set(streamId, handler)
        return () => {
          if (handlers.get(streamId) === handler) {
            handlers.delete(streamId)
          }
        }
      }
    }
  )
  return { messages, binaryFrames, handlers, dispatchPromise }
}

function sendSubscribe(
  harness: ReturnType<typeof startMultiplex>,
  streamId: number,
  terminal: string,
  clientId = 'client-desktop'
): void {
  harness.handlers.get(0)?.(
    decodeTerminalStreamFrame(
      encodeTerminalStreamFrame({
        opcode: TerminalStreamOpcode.Subscribe,
        streamId: 0,
        seq: 1,
        payload: encodeTerminalStreamJson({
          streamId,
          terminal,
          client: { id: clientId, type: 'desktop' }
        })
      })
    )!
  )
}

function sendUnsubscribe(harness: ReturnType<typeof startMultiplex>, streamId: number): void {
  harness.handlers.get(streamId)?.(
    decodeTerminalStreamFrame(
      encodeTerminalStreamFrame({
        opcode: TerminalStreamOpcode.Unsubscribe,
        streamId,
        seq: 2,
        payload: encodeTerminalStreamJson({})
      })
    )!
  )
}

async function waitForSubscribed(
  harness: ReturnType<typeof startMultiplex>,
  streamId: number
): Promise<void> {
  await vi.waitFor(() =>
    expect(
      harness.messages.some(
        (message) => message.result?.type === 'subscribed' && message.result?.streamId === streamId
      )
    ).toBe(true)
  )
}

function outputText(harness: ReturnType<typeof startMultiplex>): string {
  return harness.binaryFrames
    .map(decodeTerminalStreamFrame)
    .filter((frame) => frame?.opcode === TerminalStreamOpcode.Output)
    .map((frame) => decodeTerminalStreamText(frame!.payload))
    .join('')
}

function snapshotText(harness: ReturnType<typeof startMultiplex>): string {
  return harness.binaryFrames
    .map(decodeTerminalStreamFrame)
    .filter((frame) => frame?.opcode === TerminalStreamOpcode.SnapshotChunk)
    .map((frame) => decodeTerminalStreamText(frame!.payload))
    .join('')
}

describe('subscriber-driven daemon attach (never-activated tab)', () => {
  it('attaches on first desktop multiplex subscribe and streams bytes (snapshot-null daemon)', async () => {
    const { runtime, model, handle, mountSpy } = setupNeverAttachedDaemonSession({
      snapshotCapable: false
    })
    const harness = startMultiplex(runtime)
    await vi.waitFor(() => expect(harness.handlers.has(0)).toBe(true))

    // Baseline: nothing has attached and the daemon refuses to emit.
    expect(model.emitData(PTY_ID, 'pre-subscribe bytes')).toBe(false)

    sendSubscribe(harness, 1, handle)
    await waitForSubscribed(harness, 1)

    // Main attached the session — once — without any renderer involvement.
    await vi.waitFor(() => expect(model.attachCalls).toEqual([PTY_ID]))
    // Capability matrix: snapshot-null daemon paints blank before live bytes.
    expect(snapshotText(harness)).toBe('')

    // Now daemon bytes flow: into the stream and into the host model.
    expect(model.emitData(PTY_ID, 'hello from daemon\r\n')).toBe(true)
    await vi.waitFor(() => expect(outputText(harness)).toContain('hello from daemon'))
    expect(internals(runtime).headlessTerminals.has(PTY_ID)).toBe(true)
    const read = await runtime.readTerminal(handle)
    expect(read.tail.join('\n')).toContain('hello from daemon')

    // No resize, no renderer mount/focus/navigation, no window required.
    expect(model.resizeCalls).toEqual([])
    expect(mountSpy).not.toHaveBeenCalled()
  })

  it('paints the provider snapshot first for a snapshot-capable daemon, then goes live', async () => {
    const { runtime, model, handle } = setupNeverAttachedDaemonSession({
      snapshotCapable: true,
      screen: 'agent frozen screen\r\n'
    })
    const harness = startMultiplex(runtime)
    await vi.waitFor(() => expect(harness.handlers.has(0)).toBe(true))

    sendSubscribe(harness, 1, handle)
    await waitForSubscribed(harness, 1)

    await vi.waitFor(() => expect(model.attachCalls).toEqual([PTY_ID]))
    expect(snapshotText(harness)).toContain('agent frozen screen')

    expect(model.emitData(PTY_ID, 'now live\r\n')).toBe(true)
    await vi.waitFor(() => expect(outputText(harness)).toContain('now live'))
  })

  it('attaches once across concurrent subscribers and keeps ingesting after one releases', async () => {
    const { runtime, model, handle } = setupNeverAttachedDaemonSession({
      snapshotCapable: false
    })
    const harness = startMultiplex(runtime)
    await vi.waitFor(() => expect(harness.handlers.has(0)).toBe(true))

    sendSubscribe(harness, 1, handle, 'client-a')
    sendSubscribe(harness, 2, handle, 'client-b')
    await waitForSubscribed(harness, 1)
    await waitForSubscribed(harness, 2)

    await vi.waitFor(() => expect(model.attachCalls).toEqual([PTY_ID]))

    sendUnsubscribe(harness, 1)
    // Ingestion continues after a release: no detach, model still fed.
    expect(model.emitData(PTY_ID, 'still ingesting\r\n')).toBe(true)
    const read = await runtime.readTerminal(handle)
    expect(read.tail.join('\n')).toContain('still ingesting')

    // A late re-subscribe is a no-op re-entry, not a second attach.
    sendSubscribe(harness, 3, handle, 'client-c')
    await waitForSubscribed(harness, 3)
    expect(model.attachCalls).toEqual([PTY_ID])
  })

  it('never attaches SSH-scoped sessions or sessions absent from the daemon inventory', async () => {
    const { runtime, model } = setupNeverAttachedDaemonSession({ snapshotCapable: false })
    const sshPtyId = 'ssh:conn-9@@relay-pty-4'
    const sshRecord = internals(runtime).recordPtyWorktree(sshPtyId, WORKTREE_ID, {
      connected: true
    })
    const sshHandle = internals(runtime).issuePtyHandle(sshRecord)
    const absentPtyId = `${WORKTREE_ID}@@99999999`
    const absentRecord = internals(runtime).recordPtyWorktree(absentPtyId, WORKTREE_ID, {
      connected: true
    })
    const absentHandle = internals(runtime).issuePtyHandle(absentRecord)

    const harness = startMultiplex(runtime)
    await vi.waitFor(() => expect(harness.handlers.has(0)).toBe(true))

    sendSubscribe(harness, 1, sshHandle, 'client-ssh')
    await waitForSubscribed(harness, 1)
    expect(model.attachCalls).toEqual([])

    // Absent session: subscribing must not create it or surface a new error.
    sendSubscribe(harness, 2, absentHandle, 'client-absent')
    await waitForSubscribed(harness, 2)
    await Promise.resolve()
    expect(model.sessions.has(absentPtyId)).toBe(false)
    expect(model.emitData(absentPtyId, 'ghost')).toBe(false)
    expect(harness.messages.some((message) => message.result?.type === 'error')).toBe(false)

    // Unrelated live sessions are untouched by another pty's subscribers.
    expect(model.sessions.get(PTY_ID)?.attached).toBe(false)
    expect(model.attachCalls).not.toContain(PTY_ID)
    expect(model.resizeCalls).toEqual([])
  })

  it('retries a refused attach for a later subscriber once the daemon learns the session', async () => {
    const { runtime, model, handle } = setupNeverAttachedDaemonSession({ snapshotCapable: false })
    // Degraded-daemon shape: main knows the record, the daemon does not own the
    // id yet, and the controller answers false rather than a no-op success.
    model.sessions.delete(PTY_ID)

    const harness = startMultiplex(runtime)
    await vi.waitFor(() => expect(harness.handlers.has(0)).toBe(true))
    sendSubscribe(harness, 1, handle, 'client-a')
    await waitForSubscribed(harness, 1)
    await vi.waitFor(() => expect(model.attachCalls).toEqual([PTY_ID]))
    // A refused attach must not pin sticky success while the stream is blank.
    expect(model.emitData(PTY_ID, 'ghost')).toBe(false)

    model.sessions.set(PTY_ID, { cols: 100, rows: 30, attached: false, screen: '' })
    sendSubscribe(harness, 2, handle, 'client-b')
    await waitForSubscribed(harness, 2)
    await vi.waitFor(() => expect(model.attachCalls).toEqual([PTY_ID, PTY_ID]))
    expect(model.emitData(PTY_ID, 'late daemon hello\r\n')).toBe(true)
    await vi.waitFor(() => expect(outputText(harness)).toContain('late daemon hello'))
  })

  it('retries an existing subscriber when provider inventory becomes ready', async () => {
    const { runtime, model, handle } = setupNeverAttachedDaemonSession({
      snapshotCapable: false
    })
    model.sessions.delete(PTY_ID)
    const refuseFirstAttach = model.deferNextAttach(false)
    const harness = startMultiplex(runtime)
    await vi.waitFor(() => expect(harness.handlers.has(0)).toBe(true))

    sendSubscribe(harness, 1, handle)
    await waitForSubscribed(harness, 1)
    await vi.waitFor(() => expect(model.attachCalls).toEqual([PTY_ID]))
    expect(internals(runtime).terminalViewSubscribers.hasPendingProviderAttach(PTY_ID)).toBe(true)
    expect(runtime.hasRemoteTerminalViewSubscriber(PTY_ID)).toBe(true)
    expect(model.emitData(PTY_ID, 'before inventory\r\n')).toBe(false)

    model.sessions.set(PTY_ID, { cols: 100, rows: 30, attached: false, screen: '' })
    await internals(runtime).refreshPtyWorktreeRecordsWithControllerInventory([], null)
    await internals(runtime).refreshPtyWorktreeRecordsWithControllerInventory([], null)
    expect(model.attachCalls).toEqual([PTY_ID])
    expect(internals(runtime).terminalViewSubscribers.attachInventoryWaiterIds()).toEqual([PTY_ID])
    refuseFirstAttach()

    await vi.waitFor(() => expect(model.attachCalls).toEqual([PTY_ID, PTY_ID]))
    await vi.waitFor(() =>
      expect(internals(runtime).terminalViewSubscribers.attachInventoryWaiterIds()).not.toContain(
        PTY_ID
      )
    )
    expect(model.emitData(PTY_ID, 'after inventory\r\n')).toBe(true)
    await vi.waitFor(() => expect(outputText(harness)).toContain('after inventory'))
  })

  it('does not subscriber-attach or provider-read a session this app already spawned', async () => {
    const { runtime, model, handle } = setupNeverAttachedDaemonSession({
      snapshotCapable: true,
      screen: 'predecessor frame\r\n'
    })
    // A spawn through this app attaches its stream at spawn time; a
    // replacement under a reused id must not adopt the discovered-session path.
    runtime.onPtySpawned(PTY_ID, undefined, { awaitsRegistration: false })

    const harness = startMultiplex(runtime)
    await vi.waitFor(() => expect(harness.handlers.has(0)).toBe(true))
    sendSubscribe(harness, 1, handle)
    await waitForSubscribed(harness, 1)

    expect(model.attachCalls).toEqual([])
    const read = await runtime.readTerminal(handle)
    expect(read.tail).toEqual([])
  })

  it('terminal read falls back to the provider tail for a never-attached live pty', async () => {
    const { runtime, handle } = setupNeverAttachedDaemonSession({
      snapshotCapable: true,
      screen: 'retained daemon line\r\n'
    })

    const read = await runtime.readTerminal(handle)

    expect(read.tail.join('\n')).toContain('retained daemon line')
  })

  it('terminal read stays empty (not an error) when provider state is unprovable', async () => {
    const { runtime, handle } = setupNeverAttachedDaemonSession({ snapshotCapable: false })

    const read = await runtime.readTerminal(handle)

    expect(read.tail).toEqual([])
  })

  it('terminal read keeps preferring the ingested model over provider state once attached', async () => {
    const { runtime, model, handle } = setupNeverAttachedDaemonSession({
      snapshotCapable: true,
      screen: 'stale provider frame\r\n'
    })
    model.sessions.get(PTY_ID)!.attached = true
    model.emitData(PTY_ID, 'live model line\r\n')

    const read = await runtime.readTerminal(handle)

    expect(read.tail.join('\n')).toContain('live model line')
    expect(read.tail.join('\n')).not.toContain('stale provider frame')
  })
})
