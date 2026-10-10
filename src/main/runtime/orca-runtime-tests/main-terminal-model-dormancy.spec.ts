import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  _resetHiddenRendererPtyDeliveryGateForTest,
  isHiddenRendererPtyViewGated,
  markHiddenRendererPty,
  setDaemonQueryResponderConfirmed,
  setRendererPtyDeliveryInterest,
  shouldDropHiddenRendererPtyData,
  unmarkHiddenRendererPty
} from '../../ipc/pty-hidden-delivery-gate'
import type { RuntimePtyController } from '../runtime-pty-controller-contract'
import { MAIN_TERMINAL_MODEL_DORMANT_AFTER_MS } from '../main-terminal-model-dormancy'
import { FakeDaemonModel } from '../fake-daemon-terminal-model.test-fixture'
import {
  createRuntime,
  makeDeferred,
  parseHeadlessSnapshotLines,
  syncSinglePty
} from '../orca-runtime-test-fixtures.spec'

const GRID = { cols: 80, rows: 24 }

let now = 1_000_000

function createHarness(overrides: Partial<RuntimePtyController> = {}) {
  const daemon = new FakeDaemonModel(GRID)
  const runtime = createRuntime()
  const replies: string[] = []
  const snapshotReads = { count: 0 }
  runtime.setPtyController({
    write: (_ptyId, data, inputKind) => {
      if (inputKind === 'query-reply') {
        replies.push(data)
      }
      return true
    },
    kill: () => true,
    getForegroundProcess: async () => null,
    getSize: () => GRID,
    canProvideSettledBufferSnapshot: () => true,
    hasRendererSerializer: () => true,
    serializeProviderBuffer: async () => {
      snapshotReads.count += 1
      return daemon.snapshot()
    },
    ...overrides
  })
  syncSinglePty(runtime, 'pty-1')
  const emit = async (data: string): Promise<void> => {
    await daemon.feed(data)
    runtime.onPtyData('pty-1', data, now)
  }
  const goDormant = async (): Promise<void> => {
    await emit('one\r\n')
    now += MAIN_TERMINAL_MODEL_DORMANT_AFTER_MS
    await emit('two\r\n')
  }
  const modelLines = async (): Promise<string[]> => {
    const snapshot = await runtime.serializeMainTerminalBuffer('pty-1', { scrollbackRows: 100 })
    return parseHeadlessSnapshotLines(snapshot!, GRID)
  }
  return { daemon, runtime, replies, snapshotReads, emit, goDormant, modelLines }
}

describe('main terminal model dormancy', () => {
  beforeEach(() => {
    _resetHiddenRendererPtyDeliveryGateForTest()
    vi.spyOn(Date, 'now').mockImplementation(() => now)
  })
  afterEach(() => {
    vi.restoreAllMocks()
    _resetHiddenRendererPtyDeliveryGateForTest()
  })

  it('stops parsing a visible local daemon PTY and rebuilds an exact model on read', async () => {
    const { daemon, runtime, emit, goDormant, modelLines } = createHarness()
    await goDormant()
    expect(runtime.isMainTerminalModelDormant('pty-1')).toBe(true)
    expect(runtime.hasHeadlessTerminalState('pty-1')).toBe(true)
    await emit('three\r\n')

    expect(await modelLines()).toEqual(['one', 'two', 'three'])
    const snapshot = await runtime.serializeMainTerminalBuffer('pty-1')
    expect(snapshot?.seq).toBe(daemon.seq)
    expect(runtime.isMainTerminalModelDormant('pty-1')).toBe(false)
    expect(runtime.prefersProviderRecoverySnapshot('pty-1')).toBe(true)
  })

  it('does not reapply live bytes the daemon seed already covers', async () => {
    const seedGate = makeDeferred()
    const harness = createHarness({
      serializeProviderBuffer: async () => {
        await seedGate.promise
        return harness.daemon.snapshot()
      }
    })
    const { daemon, runtime, emit, goDormant, modelLines } = harness
    await goDormant()
    await daemon.feed('three\r\nleft')
    const read = runtime.serializeMainTerminalBuffer('pty-1')
    // In flight when the snapshot was taken: fully covered, then straddling the seed.
    runtime.onPtyData('pty-1', 'three\r\n', now)
    seedGate.resolve()
    await read
    await daemon.feed('-right\r\n')
    runtime.onPtyData('pty-1', 'left-right\r\n', now)
    await emit('four\r\n')

    expect(await modelLines()).toEqual(['one', 'two', 'three', 'left-right', 'four'])
  })

  it('keeps the hidden-delivery gate open until the rebuilt model has caught up', async () => {
    const seedGate = makeDeferred()
    const harness = createHarness({
      serializeProviderBuffer: async () => {
        await seedGate.promise
        return harness.daemon.snapshot()
      }
    })
    const { runtime, replies, emit, goDormant } = harness
    await goDormant()
    markHiddenRendererPty('pty-1')
    expect(shouldDropHiddenRendererPtyData('pty-1', undefined)).toBe(false)

    // Why: the renderer still receives this chunk and answers it; main must stay silent.
    await emit('\x1b[6n')
    seedGate.resolve()
    await runtime.serializeMainTerminalBuffer('pty-1')
    expect(shouldDropHiddenRendererPtyData('pty-1', undefined)).toBe(true)
    expect(replies).toEqual([])

    await emit('\x1b[6n')
    await runtime.serializeMainTerminalBuffer('pty-1')
    expect(replies).toEqual(['\x1b[3;1R'])
  })

  it('follows the alternate screen while dormant', async () => {
    const { runtime, emit, goDormant } = createHarness()
    await emit('\x1b[?1049h')
    await goDormant()
    expect(runtime.isMainTerminalModelDormant('pty-1')).toBe(true)
    expect(runtime.isTerminalAlternateScreen('pty-1')).toBe(true)
    await emit('\x1b[?1049l')
    expect(runtime.isTerminalAlternateScreen('pty-1')).toBe(false)
  })

  it('rebuilds the model when a remote viewer subscribes', async () => {
    const { runtime, snapshotReads, goDormant } = createHarness()
    await goDormant()
    const release = runtime.registerRemoteTerminalViewSubscriber('pty-1')
    expect(runtime.isMainTerminalModelDormant('pty-1')).toBe(false)
    await runtime.serializeMainTerminalBuffer('pty-1')
    expect(snapshotReads.count).toBe(1)
    release()
  })

  it('keeps the model live while an in-process model reader holds it', async () => {
    const { runtime, snapshotReads, emit, goDormant } = createHarness()
    await goDormant()
    const release = runtime.acquireTerminalOutputReader('pty-1', { kind: 'model' })
    expect(runtime.isMainTerminalModelDormant('pty-1')).toBe(false)
    await runtime.serializeMainTerminalBuffer('pty-1')
    now += MAIN_TERMINAL_MODEL_DORMANT_AFTER_MS * 2
    await emit('held\r\n')
    expect(runtime.isMainTerminalModelDormant('pty-1')).toBe(false)
    release()
    now += MAIN_TERMINAL_MODEL_DORMANT_AFTER_MS
    await emit('released\r\n')
    expect(runtime.isMainTerminalModelDormant('pty-1')).toBe(true)
    expect(snapshotReads.count).toBe(1)
  })

  it.each([
    ['the daemon cannot serve settled snapshots', { canProvideSettledBufferSnapshot: () => false }],
    ['no renderer pane parses the bytes', { hasRendererSerializer: () => false }]
  ])('keeps main parsing when %s', async (_name, overrides) => {
    const { runtime, goDormant } = createHarness(overrides)
    await goDormant()
    expect(runtime.isMainTerminalModelDormant('pty-1')).toBe(false)
    expect(runtime.prefersProviderRecoverySnapshot('pty-1')).toBe(false)
  })

  it('keeps main parsing for a hidden PTY whose sidecars still get its bytes', async () => {
    const { runtime, goDormant } = createHarness()
    setRendererPtyDeliveryInterest('pty-1', true)
    markHiddenRendererPty('pty-1')
    await goDormant()
    expect(runtime.isMainTerminalModelDormant('pty-1')).toBe(false)
  })

  it('keeps main parsing for an agent identified by its title', async () => {
    const { runtime, emit, goDormant } = createHarness()
    await emit('\x1b]0;Codex working\x07')
    await goDormant()
    expect(runtime.isMainTerminalModelDormant('pty-1')).toBe(false)
  })

  it('keeps main parsing once a rebuild fails, and marks the model partial', async () => {
    const { runtime, goDormant, emit } = createHarness({
      serializeProviderBuffer: async () => null
    })
    await goDormant()
    markHiddenRendererPty('pty-1')
    await runtime.serializeMainTerminalBuffer('pty-1')
    expect(shouldDropHiddenRendererPtyData('pty-1', undefined)).toBe(true)
    now += MAIN_TERMINAL_MODEL_DORMANT_AFTER_MS * 2
    await emit('later\r\n')
    expect(runtime.isMainTerminalModelDormant('pty-1')).toBe(false)
  })
})

describe('daemon query responder delegation', () => {
  beforeEach(() => {
    _resetHiddenRendererPtyDeliveryGateForTest()
    vi.spyOn(Date, 'now').mockImplementation(() => now)
  })
  afterEach(() => {
    vi.restoreAllMocks()
    _resetHiddenRendererPtyDeliveryGateForTest()
  })

  function createDelegatingHarness(canDelegate: () => boolean = () => true) {
    const requests: boolean[] = []
    const harness = createHarness({
      canDelegateDaemonQueryResponder: canDelegate,
      setDaemonQueryResponder: (_ptyId, responder) => {
        requests.push(responder)
        return true
      }
    })
    // Mirrors bind-listeners: the gate applies the in-order marker, then the runtime.
    const marker = (responder: boolean): void => {
      setDaemonQueryResponderConfirmed('pty-1', responder)
      harness.runtime.noteDaemonQueryResponderMarker('pty-1', responder)
    }
    return { ...harness, requests, marker }
  }

  it("hands a hidden PTY's queries to the daemon, then lets main's model rest", async () => {
    const { runtime, replies, requests, emit, marker } = createDelegatingHarness()
    await emit('one\r\n')
    markHiddenRendererPty('pty-1')
    expect(requests).toEqual([true])
    // Why: main's live model answers until the daemon's marker, so the view stays gated.
    expect(shouldDropHiddenRendererPtyData('pty-1', undefined)).toBe(true)
    await emit('\x1b[6n')
    await runtime.serializeMainTerminalBuffer('pty-1')
    expect(replies).toEqual(['\x1b[2;1R'])

    marker(true)
    await emit('\x1b[6n')
    await runtime.serializeMainTerminalBuffer('pty-1')
    expect(replies).toEqual(['\x1b[2;1R'])

    now += MAIN_TERMINAL_MODEL_DORMANT_AFTER_MS
    await emit('quiet\r\n')
    expect(runtime.isMainTerminalModelDormant('pty-1')).toBe(true)
  })

  it('answers from main again once the daemon lets go of a pane that stays hidden', async () => {
    let eligible = true
    const { runtime, replies, requests, emit, marker } = createDelegatingHarness(() => eligible)
    await emit('one\r\n')
    markHiddenRendererPty('pty-1')
    marker(true)

    eligible = false
    // Why: the daemon answers until its marker, so this chunk is still its own.
    await emit('\x1b[6n')
    await runtime.serializeMainTerminalBuffer('pty-1')
    expect(requests).toEqual([true, false])
    expect(replies).toEqual([])

    marker(false)
    await emit('\x1b[6n')
    await runtime.serializeMainTerminalBuffer('pty-1')
    expect(replies).toEqual(['\x1b[2;1R'])
  })

  it('keeps the daemon answering a hidden pane until main has rebuilt its model', async () => {
    let eligible = true
    const { runtime, replies, requests, emit, goDormant, marker } = createDelegatingHarness(
      () => eligible
    )
    await goDormant()
    markHiddenRendererPty('pty-1')
    marker(true)

    eligible = false
    await emit('\x1b[6n')
    expect(requests).toEqual([true])
    await runtime.serializeMainTerminalBuffer('pty-1')
    await emit('x')
    expect(requests).toEqual([true, false])
    expect(replies).toEqual([])

    marker(false)
    await emit('\x1b[6n')
    await runtime.serializeMainTerminalBuffer('pty-1')
    expect(replies).toEqual(['\x1b[3;2R'])
  })

  it("reveals a delegated pane after the daemon's take-back without waking main", async () => {
    const { runtime, requests, snapshotReads, emit, goDormant, marker } = createDelegatingHarness()
    await goDormant()
    markHiddenRendererPty('pty-1')
    expect(runtime.isMainTerminalModelDormant('pty-1')).toBe(true)
    // Why: a dormant main cannot answer, so the view does until the daemon's marker.
    expect(isHiddenRendererPtyViewGated('pty-1', undefined)).toBe(false)
    marker(true)
    expect(isHiddenRendererPtyViewGated('pty-1', undefined)).toBe(true)

    unmarkHiddenRendererPty('pty-1')
    expect(requests).toEqual([true, false])
    expect(shouldDropHiddenRendererPtyData('pty-1', undefined)).toBe(true)
    marker(false)
    expect(shouldDropHiddenRendererPtyData('pty-1', undefined)).toBe(false)

    await emit('visible\r\n')
    expect(runtime.isMainTerminalModelDormant('pty-1')).toBe(true)
    expect(snapshotReads.count).toBe(0)
  })

  it('takes the queries back for a model reader or a remote viewer', async () => {
    const { runtime, requests, marker } = createDelegatingHarness()
    markHiddenRendererPty('pty-1')
    marker(true)
    const release = runtime.acquireTerminalOutputReader('pty-1', { kind: 'model' })
    expect(requests).toEqual([true, false])
    release()
    marker(false)

    unmarkHiddenRendererPty('pty-1')
    markHiddenRendererPty('pty-1')
    expect(requests).toEqual([true, false, true])
    const releaseViewer = runtime.registerRemoteTerminalViewSubscriber('pty-1')
    expect(requests).toEqual([true, false, true, false])
    releaseViewer()
  })

  it('keeps main answering a hidden pane whose daemon cannot take its queries', async () => {
    const { runtime, replies, requests, emit } = createDelegatingHarness(() => false)
    await emit('one\r\n')
    markHiddenRendererPty('pty-1')
    await emit('\x1b[6n')
    await runtime.serializeMainTerminalBuffer('pty-1')
    expect(requests).toEqual([])
    expect(replies).toEqual(['\x1b[2;1R'])
  })
})
