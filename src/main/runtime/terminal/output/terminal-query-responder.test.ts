/** Verify emulator reply parity, per-chunk ownership, replay silence and capture races. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../../orca-runtime'
import { HeadlessEmulator } from '../../../daemon/emulation/headless-emulator'
import {
  _resetHiddenRendererPtyDeliveryGateForTest,
  markHiddenRendererPty,
  unmarkHiddenRendererPty
} from '../../../ipc/pty/delivery/pty-hidden-delivery-gate'
import {
  _resetTerminalModelQueryAuthorityForTest,
  markNativeWindowsConptyPty
} from './terminal-model-query-authority'
import {
  _resetTerminalViewAttributesForTest,
  setTerminalViewAttributes
} from '../view/terminal-view-attribute-store'
import type {
  TerminalViewAttributes,
  TerminalViewRgb
} from '../../../../shared/terminal/protocol/queries/terminal-view-attributes'
import type { TerminalInputKind } from '../../../../shared/terminal/input/terminal-input-kind'

const QUERY_BATCH = '\x1b[c\x1b]11;?\x07\x1b[?996n'

const settingsState = {
  terminalMainSideEffectAuthority: true as boolean,
  terminalHiddenDeliveryGate: true as boolean,
  terminalModelQueryAuthority: true as boolean
}

const store = {
  getRepo: () => undefined,
  getRepos: () => [],
  addRepo: () => {},
  updateRepo: () => undefined as never,
  getAllWorktreeMeta: () => ({}),
  getWorktreeMeta: () => undefined,
  setWorktreeMeta: () => undefined as never,
  removeWorktreeMeta: () => {},
  getRetiredWorktreeNameRegistry: () => ({ exhaustedTiers: 0, names: [] }),
  addRetiredWorktreeName: () => {},
  mergeRetiredWorktreeNames: () => false,
  getGitHubCache: () => ({ pr: {}, issue: {} }) as never,
  getSettings: () => ({
    workspaceDir: '/tmp/workspaces',
    nestWorkspaces: false,
    refreshLocalBaseRefOnWorktreeCreate: false,
    branchPrefix: 'none',
    branchPrefixCustom: '',
    terminalMainSideEffectAuthority: settingsState.terminalMainSideEffectAuthority,
    terminalHiddenDeliveryGate: settingsState.terminalHiddenDeliveryGate,
    terminalModelQueryAuthority: settingsState.terminalModelQueryAuthority
  })
}

type RendererBufferStub = { data: string; cols: number; rows: number }

function createResponderRuntime(opts: { rendererBuffer?: RendererBufferStub } = {}) {
  const runtime = new OrcaRuntimeService(store)
  const replies: { ptyId: string; data: string }[] = []
  const inputKinds: TerminalInputKind[] = []
  runtime.setPtyController({
    write: (ptyId, data, inputKind) => {
      replies.push({ ptyId, data })
      inputKinds.push(inputKind)
      return true
    },
    kill: () => true,
    getForegroundProcess: async () => null,
    getSize: () => ({ cols: 80, rows: 24 }),
    resize: () => true,
    ...(opts.rendererBuffer
      ? {
          hasRendererSerializer: () => true,
          serializeBuffer: async () => opts.rendererBuffer ?? null
        }
      : {})
  })
  return { runtime, replies, inputKinds }
}

/** Awaits the per-PTY emulator writeChain so queued chunk links (and the
 *  replies they forward) have settled. */
async function settle(runtime: OrcaRuntimeService, ptyId: string): Promise<void> {
  await runtime.serializeMainTerminalBuffer(ptyId)
}

/** Renderer-pushed attribute snapshot with distinct, pinned slot values so
 *  reply fixtures cannot pass by coincidence. */
function viewAttributes(overrides: Partial<TerminalViewAttributes> = {}): TerminalViewAttributes {
  const ansi = Array.from(
    { length: 256 },
    (_, i) => [i, (i * 2) % 256, (i * 3) % 256] as TerminalViewRgb
  )
  ansi[1] = [0xcc, 0x00, 0x00]
  return {
    foreground: [0xd0, 0xd0, 0xd0],
    background: [0x1e, 0x1e, 0x2e],
    cursor: [0xff, 0x99, 0x00],
    ansi,
    colorSchemeMode: 'dark',
    cursorStyle: 'bar',
    cursorBlink: true,
    ...overrides
  }
}

afterEach(() => {
  _resetHiddenRendererPtyDeliveryGateForTest()
  _resetTerminalModelQueryAuthorityForTest()
  _resetTerminalViewAttributesForTest()
  settingsState.terminalMainSideEffectAuthority = true
  settingsState.terminalHiddenDeliveryGate = true
  settingsState.terminalModelQueryAuthority = true
})

describe('reply ownership matrix', () => {
  it('yields until every remote view subscriber releases, including repeated release', async () => {
    const { runtime, replies } = createResponderRuntime()
    setTerminalViewAttributes(viewAttributes())
    markHiddenRendererPty('pty-r')
    const releaseA = runtime.registerRemoteTerminalViewSubscriber('pty-r')
    const releaseB = runtime.registerRemoteTerminalViewSubscriber('pty-r')
    expect(runtime.hasRemoteTerminalViewSubscriber('pty-r')).toBe(true)

    runtime.onPtyData('pty-r', QUERY_BATCH, Date.now())
    await settle(runtime, 'pty-r')
    expect(replies).toEqual([])

    releaseA()
    releaseA()
    expect(runtime.hasRemoteTerminalViewSubscriber('pty-r')).toBe(true)
    runtime.onPtyData('pty-r', QUERY_BATCH, Date.now())
    await settle(runtime, 'pty-r')
    expect(replies).toEqual([])

    releaseB()
    expect(runtime.hasRemoteTerminalViewSubscriber('pty-r')).toBe(false)
    runtime.onPtyData('pty-r', QUERY_BATCH, Date.now())
    await settle(runtime, 'pty-r')
    expect(replies.map((reply) => reply.data)).toEqual([
      '\x1b[?1;2c',
      '\x1b]11;rgb:1e1e/1e1e/2e2e\x1b\\',
      '\x1b[?997;1n'
    ])
  })

  // #32944: a paired desktop pauses a background pane's stream, so the DA1 fish waits on reaches no xterm.
  it('answers while the only remote view has paused its output, and yields once it resumes', async () => {
    const { runtime, replies } = createResponderRuntime()
    markHiddenRendererPty('pty-paused')
    let paused = true
    const releasePaused = runtime.registerRemoteTerminalViewSubscriber('pty-paused', () => paused)

    runtime.onPtyData('pty-paused', '\x1b[c', Date.now())
    await settle(runtime, 'pty-paused')
    expect(replies.map((reply) => reply.data)).toEqual(['\x1b[?1;2c'])

    paused = false
    runtime.onPtyData('pty-paused', '\x1b[c', Date.now())
    await settle(runtime, 'pty-paused')
    expect(replies).toHaveLength(1)

    // A second, receiving view keeps authority even while the first pauses again.
    paused = true
    const releaseLive = runtime.registerRemoteTerminalViewSubscriber('pty-paused', () => false)
    runtime.onPtyData('pty-paused', '\x1b[c', Date.now())
    await settle(runtime, 'pty-paused')
    expect(replies).toHaveLength(1)

    releaseLive()
    releasePaused()
    runtime.onPtyData('pty-paused', '\x1b[c', Date.now())
    await settle(runtime, 'pty-paused')
    expect(replies).toHaveLength(2)
  })

  it('yields to a phone-fitted mobile view but answers for a passive desktop-size one', async () => {
    const { runtime, replies } = createResponderRuntime()
    markHiddenRendererPty('pty-fit')
    runtime.registerRemoteTerminalViewSubscriber('pty-fit', () => false, 'client-1')
    await runtime.handleMobileSubscribe('pty-fit', 'client-1', { cols: 40, rows: 20 })
    runtime.onPtyData('pty-fit', '\x1b[6n', 1_000)
    await settle(runtime, 'pty-fit')
    expect(replies).toEqual([])

    markHiddenRendererPty('pty-passive')
    runtime.setMobileDisplayMode('pty-passive', 'desktop')
    runtime.registerRemoteTerminalViewSubscriber('pty-passive', () => false, 'client-1')
    await runtime.handleMobileSubscribe('pty-passive', 'client-1', { cols: 40, rows: 20 })
    runtime.onPtyData('pty-passive', '\x1b[6n', 1_000)
    await settle(runtime, 'pty-passive')
    expect(replies.map((reply) => reply.data)).toEqual(['\x1b[1;1R'])
  })
})

describe('main-side replay guard', () => {
  it('silences queued and replayed queries across model recovery, then answers live bytes', async () => {
    const { runtime, replies } = createResponderRuntime()
    setTerminalViewAttributes(viewAttributes())
    markHiddenRendererPty('pty-recovered')
    runtime.seedHeadlessTerminal('pty-recovered', 'old screen')
    await settle(runtime, 'pty-recovered')
    runtime.onPtyData('pty-recovered', QUERY_BATCH, Date.now())
    runtime.replaceHeadlessTerminalFromRendererSnapshotForRecovery(
      'pty-recovered',
      { data: `restored prompt${QUERY_BATCH}`, cols: 80, rows: 24, seq: 0 },
      [{ data: QUERY_BATCH, seq: runtime.getPtyOutputSequence('pty-recovered') }]
    )
    await settle(runtime, 'pty-recovered')
    expect(replies).toEqual([])
    runtime.onPtyData('pty-recovered', QUERY_BATCH, Date.now())
    await settle(runtime, 'pty-recovered')
    expect(replies.map((reply) => reply.data)).toEqual([
      '\x1b[?1;2c',
      '\x1b]11;rgb:1e1e/1e1e/2e2e\x1b\\',
      '\x1b[?997;1n'
    ])
  })

  it('never answers queries embedded in a seeded snapshot, then answers live bytes', async () => {
    const { runtime, replies } = createResponderRuntime()
    setTerminalViewAttributes(viewAttributes())
    markHiddenRendererPty('pty-seed')

    runtime.seedHeadlessTerminal('pty-seed', `restored prompt${QUERY_BATCH}`)
    await settle(runtime, 'pty-seed')
    expect(replies).toEqual([])

    runtime.onPtyData('pty-seed', QUERY_BATCH, Date.now())
    await settle(runtime, 'pty-seed')
    expect(replies.map((reply) => reply.data)).toEqual([
      '\x1b[?1;2c',
      '\x1b]11;rgb:1e1e/1e1e/2e2e\x1b\\',
      '\x1b[?997;1n'
    ])
  })
})

describe('kitty flag re-seed parity (terminal-query-authority.md §kitty)', () => {
  it('answers ?u with the persisted snapshot flags after a re-seed, silently applied', async () => {
    const { runtime, replies } = createResponderRuntime()
    markHiddenRendererPty('pty-kitty')

    // Warm-reattach kitty flags seed state and must emit no replies.
    runtime.seedHeadlessTerminal('pty-kitty', 'restored prompt', undefined, {
      kittyKeyboardFlags: 5
    })
    await settle(runtime, 'pty-kitty')
    expect(replies).toEqual([])

    runtime.onPtyData('pty-kitty', '\x1b[?u', Date.now())
    await settle(runtime, 'pty-kitty')
    expect(replies.map((reply) => reply.data)).toEqual(['\x1b[?5u'])
  })
})

describe('ingestion-time ownership capture', () => {
  const DA1 = '\x1b[c'

  it('still answers when the hidden mark flips off between ingestion and the async write', async () => {
    const { runtime, replies } = createResponderRuntime()
    markHiddenRendererPty('pty-race')

    runtime.onPtyData('pty-race', DA1, Date.now())
    // Flip before the queued writeChain link runs: the captured decision wins.
    unmarkHiddenRendererPty('pty-race')
    await settle(runtime, 'pty-race')

    expect(replies.map((reply) => reply.data)).toEqual(['\x1b[?1;2c'])
  })
})

describe('stale writeChain links after dispose', () => {
  const DA1 = '\x1b[c'

  it('never injects a stale reply into a successor PTY reusing the session id', async () => {
    const { runtime, replies } = createResponderRuntime()
    markHiddenRendererPty('pty-reuse')

    // Daemon respawns reuse session ids: dispose with the flagged link still
    // queued, then re-create the same id before the link runs.
    runtime.onPtyData('pty-reuse', DA1, Date.now())
    runtime.onPtyExit('pty-reuse', 0)
    runtime.onPtyData('pty-reuse', 'fresh shell banner', Date.now())
    await settle(runtime, 'pty-reuse')

    expect(replies).toEqual([])
  })
})

describe('ConPTY DA1 override', () => {
  it('retrofits the override when the spawn mark lands after data created the emulator', async () => {
    const { runtime, replies } = createResponderRuntime()
    markHiddenRendererPty('pty-win-late')

    // Daemon warm-reattach flush: stream data creates the emulator before
    // the awaited spawn response marks the PTY native-Windows.
    runtime.onPtyData('pty-win-late', 'warm reattach flush', Date.now())
    markNativeWindowsConptyPty('pty-win-late')

    runtime.onPtyData('pty-win-late', '\x1b[c', Date.now())
    await settle(runtime, 'pty-win-late')

    expect(replies.map((reply) => reply.data)).toEqual(['\x1b[?61;4c'])
  })
})

describe('HeadlessEmulator forwarding window', () => {
  it('scopes the async-fallback forwarding window to the flagged chunk parse', async () => {
    const onQueryReply = vi.fn()
    const emulator = new HeadlessEmulator({ cols: 80, rows: 24, onQueryReply })
    // Exercise async xterm writes without writeChain serialization; writeSync is deprecated.
    const internals = emulator as unknown as { terminal: { _core: { writeSync?: unknown } } }
    internals.terminal._core.writeSync = undefined
    try {
      // Queue unflagged seed and flagged live writes together; the seed must not borrow the live reply window.
      const seed = emulator.write('seeded\x1b[c')
      const live = emulator.write('\x1b[5n', { forwardQueryReplies: true })
      await Promise.all([seed, live])

      expect(onQueryReply.mock.calls.map((call) => call[0])).toEqual(['\x1b[0n'])
    } finally {
      emulator.dispose()
    }
  })

  it('keeps the ConPTY override inside the forwarding window', async () => {
    const onQueryReply = vi.fn()
    const emulator = new HeadlessEmulator({ cols: 80, rows: 24, onQueryReply })
    emulator.installConptyPrimaryDeviceAttributesOverride()
    try {
      // Unflagged (replayed/seeded) DA1 must answer no one even with the
      // override installed.
      await emulator.write('\x1b[c')
      expect(onQueryReply).not.toHaveBeenCalled()

      await emulator.write('\x1b[c', { forwardQueryReplies: true })
      expect(onQueryReply).toHaveBeenCalledTimes(1)
      expect(onQueryReply).toHaveBeenCalledWith('\x1b[?61;4c')
    } finally {
      emulator.dispose()
    }
  })
})

describe('view-attribute bridge replies (after renderer push)', () => {
  it('stays silent before the first push, then answers the same query after it', async () => {
    const { runtime, replies } = createResponderRuntime()
    markHiddenRendererPty('pty-first')

    runtime.onPtyData('pty-first', '\x1b]11;?\x07\x1b[?996n', Date.now())
    await settle(runtime, 'pty-first')
    // No fabricated defaults: silence is the documented hidden status quo.
    expect(replies).toEqual([])

    setTerminalViewAttributes(viewAttributes())
    runtime.onPtyData('pty-first', '\x1b]11;?\x07', Date.now())
    await settle(runtime, 'pty-first')
    expect(replies.map((reply) => reply.data)).toEqual(['\x1b]11;rgb:1e1e/1e1e/2e2e\x1b\\'])
  })
})

describe('per-PTY OSC color SET layering', () => {
  it('layers an OSC 4 SET over the pushed base, isolated per PTY', async () => {
    const { runtime, replies } = createResponderRuntime()
    markHiddenRendererPty('pty-a')
    markHiddenRendererPty('pty-b')
    setTerminalViewAttributes(viewAttributes())

    runtime.onPtyData('pty-a', '\x1b]4;1;rgb:00/ff/00\x07\x1b]4;1;?\x07', Date.now())
    runtime.onPtyData('pty-b', '\x1b]4;1;?\x07', Date.now())
    await settle(runtime, 'pty-a')
    await settle(runtime, 'pty-b')

    expect(replies).toEqual([
      { ptyId: 'pty-a', data: '\x1b]4;1;rgb:0000/ffff/0000\x1b\\' },
      { ptyId: 'pty-b', data: '\x1b]4;1;rgb:cccc/0000/0000\x1b\\' }
    ])
  })

  it('tracks SET mutations parsed from a seed without replying, like renderer replay', async () => {
    // Restored OSC SETs update theme state like visible xterm, while replay remains silent.
    const { runtime, replies } = createResponderRuntime()
    markHiddenRendererPty('pty-seedset')
    setTerminalViewAttributes(viewAttributes())

    runtime.seedHeadlessTerminal('pty-seedset', 'restored\x1b]4;1;#00ff00\x07\x1b]4;1;?\x07')
    await settle(runtime, 'pty-seedset')
    expect(replies).toEqual([])

    runtime.onPtyData('pty-seedset', '\x1b]4;1;?\x07', Date.now())
    await settle(runtime, 'pty-seedset')
    expect(replies.map((reply) => reply.data)).toEqual(['\x1b]4;1;rgb:0000/ffff/0000\x1b\\'])
  })

  it('preserves per-PTY overrides on an identical re-push (fresh renderer process)', async () => {
    const { runtime, replies } = createResponderRuntime()
    markHiddenRendererPty('pty-idem')
    setTerminalViewAttributes(viewAttributes())

    runtime.onPtyData('pty-idem', '\x1b]11;#ffffff\x07', Date.now())
    await settle(runtime, 'pty-idem')

    // Identical renderer re-pushes after reload/window activation are not theme applies and must retain OSC SET overlays.
    setTerminalViewAttributes(viewAttributes())
    runtime.onPtyData('pty-idem', '\x1b]11;?\x07', Date.now())
    await settle(runtime, 'pty-idem')

    expect(replies.map((reply) => reply.data)).toEqual(['\x1b]11;rgb:ffff/ffff/ffff\x1b\\'])
  })

  it('clears per-PTY overrides when a new push lands (theme apply parity)', async () => {
    const { runtime, replies } = createResponderRuntime()
    markHiddenRendererPty('pty-clear')
    setTerminalViewAttributes(viewAttributes())

    runtime.onPtyData('pty-clear', '\x1b]11;#ffffff\x07', Date.now())
    await settle(runtime, 'pty-clear')

    // Changed theme pushes reset OSC SET overlays like visible xterm ThemeService._setTheme.
    setTerminalViewAttributes(viewAttributes({ background: [0x10, 0x20, 0x30] }))
    runtime.onPtyData('pty-clear', '\x1b]11;?\x07', Date.now())
    await settle(runtime, 'pty-clear')

    expect(replies.map((reply) => reply.data)).toEqual(['\x1b]11;rgb:1010/2020/3030\x1b\\'])
  })
})
