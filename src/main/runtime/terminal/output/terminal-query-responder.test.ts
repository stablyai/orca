/** Verify emulator reply parity, per-chunk ownership, replay silence and capture races. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../../orca-runtime'
import { HeadlessEmulator } from '../../../daemon/emulation/headless-emulator'
import {
  _resetHiddenRendererPtyDeliveryGateForTest,
  markHiddenRendererPty,
  setRendererPtyDeliveryInterest,
  unmarkHiddenRendererPty
} from '../../../ipc/pty/delivery/pty-hidden-delivery-gate'
import {
  _resetTerminalModelQueryAuthorityForTest,
  markNativeWindowsConptyPty
} from './terminal-model-query-authority'
import {
  _resetTerminalViewAttributesForTest,
  setRepoTerminalViewAttributes,
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

describe('view-attribute replay guard and suppression', () => {
  it('never answers view-attribute queries embedded in a seeded snapshot', async () => {
    const { runtime, replies } = createResponderRuntime()
    markHiddenRendererPty('pty-vseed')
    setTerminalViewAttributes(viewAttributes())

    runtime.seedHeadlessTerminal('pty-vseed', 'prompt\x1b]11;?\x07\x1b[?996n')
    await settle(runtime, 'pty-vseed')
    expect(replies).toEqual([])

    runtime.onPtyData('pty-vseed', '\x1b]11;?\x07', Date.now())
    await settle(runtime, 'pty-vseed')
    expect(replies.map((reply) => reply.data)).toEqual(['\x1b]11;rgb:1e1e/1e1e/2e2e\x1b\\'])
  })

  it('never answers view-attribute queries replayed by renderer-buffer hydration', async () => {
    const { runtime, replies } = createResponderRuntime({
      rendererBuffer: { data: 'restored\x1b]11;?\x07\x1b[?996n', cols: 80, rows: 24 }
    })
    markHiddenRendererPty('pty-vhyd')
    setTerminalViewAttributes(viewAttributes())

    runtime.onPtyData('pty-vhyd', 'live output', Date.now())
    await settle(runtime, 'pty-vhyd')

    expect(replies).toEqual([])
  })

  it('never answers a delivered (unmarked) view-attribute query — the visible xterm owns it', async () => {
    const { runtime, replies } = createResponderRuntime()
    setTerminalViewAttributes(viewAttributes())

    runtime.onPtyData('pty-vvis', '\x1b]11;?\x07\x1b[?996n', Date.now())
    await settle(runtime, 'pty-vvis')

    expect(replies).toEqual([])
  })

  it('never answers while renderer delivery interest holds the chunk delivered', async () => {
    const { runtime, replies } = createResponderRuntime()
    markHiddenRendererPty('pty-vint')
    setRendererPtyDeliveryInterest('pty-vint', true)
    setTerminalViewAttributes(viewAttributes())

    runtime.onPtyData('pty-vint', '\x1b]11;?\x07', Date.now())
    await settle(runtime, 'pty-vint')

    expect(replies).toEqual([])
  })

  it('yields view-attribute replies while a remote view subscriber is attached', async () => {
    const { runtime, replies } = createResponderRuntime()
    markHiddenRendererPty('pty-vrem')
    setTerminalViewAttributes(viewAttributes())
    const release = runtime.registerRemoteTerminalViewSubscriber('pty-vrem')

    runtime.onPtyData('pty-vrem', '\x1b]11;?\x07', Date.now())
    await settle(runtime, 'pty-vrem')
    expect(replies).toEqual([])

    release()
    runtime.onPtyData('pty-vrem', '\x1b]11;?\x07', Date.now())
    await settle(runtime, 'pty-vrem')
    expect(replies.map((reply) => reply.data)).toEqual(['\x1b]11;rgb:1e1e/1e1e/2e2e\x1b\\'])
  })

  it.each([
    ['terminalModelQueryAuthority', () => (settingsState.terminalModelQueryAuthority = false)],
    ['terminalHiddenDeliveryGate', () => (settingsState.terminalHiddenDeliveryGate = false)],
    [
      'terminalMainSideEffectAuthority',
      () => (settingsState.terminalMainSideEffectAuthority = false)
    ]
  ])('never answers view-attribute queries with kill switch %s off', async (_label, flip) => {
    flip()
    const { runtime, replies } = createResponderRuntime()
    markHiddenRendererPty('pty-vkill')
    setTerminalViewAttributes(viewAttributes())

    runtime.onPtyData('pty-vkill', '\x1b]11;?\x07\x1b[?996n', Date.now())
    await settle(runtime, 'pty-vkill')

    expect(replies).toEqual([])
  })
})

describe('per-repo view attributes', () => {
  const SOLARIZED = { background: [0x00, 0x2b, 0x36], foreground: [0x83, 0x94, 0x96] } as const
  const SOLARIZED_BG_REPLY = '\x1b]11;rgb:0000/2b2b/3636\x1b\\'
  const GLOBAL_BG_REPLY = '\x1b]11;rgb:1e1e/1e1e/2e2e\x1b\\'
  const repoAttributes = (): TerminalViewAttributes =>
    viewAttributes({ background: [...SOLARIZED.background], foreground: [...SOLARIZED.foreground] })

  async function query(
    runtime: OrcaRuntimeService,
    replies: { ptyId: string; data: string }[],
    ptyId: string,
    chunk: string
  ): Promise<string[]> {
    const before = replies.length
    runtime.onPtyData(ptyId, chunk, Date.now())
    await settle(runtime, ptyId)
    return replies.slice(before).map((reply) => reply.data)
  }

  it('answers a registered themed-repo PTY from its repo palette', async () => {
    const { runtime, replies } = createResponderRuntime()
    runtime.registerPty('pty-themed', 'repoA::/a')
    markHiddenRendererPty('pty-themed')
    setTerminalViewAttributes(viewAttributes())
    setRepoTerminalViewAttributes({ byHostId: { local: { repoA: repoAttributes() } } })

    expect(
      await query(runtime, replies, 'pty-themed', '\x1b]11;?\x07\x1b]10;?\x07\x1b[?996n')
    ).toEqual([SOLARIZED_BG_REPLY, '\x1b]10;rgb:8383/9494/9696\x1b\\', '\x1b[?997;1n'])
  })

  it('infers the repo from a daemon-style PTY id before graph sync records it', async () => {
    const { runtime, replies } = createResponderRuntime()
    markHiddenRendererPty('repoA::/a@@1')
    setTerminalViewAttributes(viewAttributes())
    setRepoTerminalViewAttributes({ byHostId: { local: { repoA: repoAttributes() } } })

    expect(await query(runtime, replies, 'repoA::/a@@1', '\x1b]11;?\x07')).toEqual([
      SOLARIZED_BG_REPLY
    ])
  })

  it('answers unthemed-repo and folder-workspace PTYs from the global palette', async () => {
    const { runtime, replies } = createResponderRuntime()
    runtime.registerPty('pty-plain', 'repoB::/b')
    markHiddenRendererPty('pty-plain')
    markHiddenRendererPty('folder:x@@1')
    setTerminalViewAttributes(viewAttributes())
    setRepoTerminalViewAttributes({ byHostId: { local: { repoA: repoAttributes() } } })

    expect(await query(runtime, replies, 'pty-plain', '\x1b]11;?\x07')).toEqual([GLOBAL_BG_REPLY])
    expect(await query(runtime, replies, 'folder:x@@1', '\x1b]11;?\x07')).toEqual([GLOBAL_BG_REPLY])
  })

  it('clears OSC SET overlays only on PTYs whose effective palette changed', async () => {
    const { runtime, replies } = createResponderRuntime()
    runtime.registerPty('pty-a', 'repoA::/a')
    runtime.registerPty('pty-g', 'repoB::/b')
    markHiddenRendererPty('pty-a')
    markHiddenRendererPty('pty-g')
    setTerminalViewAttributes(viewAttributes())
    setRepoTerminalViewAttributes({ byHostId: { local: { repoA: repoAttributes() } } })
    const setGreen = '\x1b]4;1;#00ff00\x07'
    const ask = '\x1b]4;1;?\x07'
    const green = '\x1b]4;1;rgb:0000/ffff/0000\x1b\\'
    const baseRed = '\x1b]4;1;rgb:cccc/0000/0000\x1b\\'
    await query(runtime, replies, 'pty-a', setGreen)
    await query(runtime, replies, 'pty-g', setGreen)

    setTerminalViewAttributes(viewAttributes({ background: [0x10, 0x20, 0x30] }))
    expect(await query(runtime, replies, 'pty-a', ask)).toEqual([green])
    expect(await query(runtime, replies, 'pty-g', ask)).toEqual([baseRed])

    await query(runtime, replies, 'pty-g', setGreen)
    setRepoTerminalViewAttributes({
      byHostId: { local: { repoA: viewAttributes({ background: [0x07, 0x36, 0x42] }) } }
    })
    expect(await query(runtime, replies, 'pty-a', ask)).toEqual([baseRed])
    expect(await query(runtime, replies, 'pty-g', ask)).toEqual([green])
  })

  it('keeps a SET made before an opaque-id PTY is registered through an unrelated later push', async () => {
    // In-process ids ("7") carry no worktree, and spawn-commit registers the PTY only after a
    // persistence await, so shell rc output can SET colours while the scope is still global.
    const { runtime, replies } = createResponderRuntime()
    setTerminalViewAttributes(viewAttributes())
    setRepoTerminalViewAttributes({ byHostId: { local: { repoA: repoAttributes() } } })
    markHiddenRendererPty('7')
    const setGreen = '\x1b]4;1;#00ff00\x07'
    const ask = '\x1b]4;1;?\x07'
    const green = '\x1b]4;1;rgb:0000/ffff/0000\x1b\\'
    await query(runtime, replies, '7', setGreen)
    runtime.registerPty('7', 'repoA::/a')
    expect(await query(runtime, replies, '7', ask)).toEqual([green])

    // Another project's theme is edited; repoA's palette is unchanged, as its visible pane shows.
    setRepoTerminalViewAttributes({
      byHostId: {
        local: { repoA: repoAttributes(), repoB: viewAttributes({ background: [1, 2, 3] }) }
      }
    })
    expect(await query(runtime, replies, '7', ask)).toEqual([green])

    // The project's own theme changing still replaces the palette, like the pane's theme apply.
    setRepoTerminalViewAttributes({
      byHostId: { local: { repoA: viewAttributes({ background: [0x07, 0x36, 0x42] }) } }
    })
    expect(await query(runtime, replies, '7', ask)).toEqual(['\x1b]4;1;rgb:cccc/0000/0000\x1b\\'])
  })

  it('keeps a SET made in the restart window through the first repo push', async () => {
    // Fresh main: the global push lands first; the repo map arrives once the catalog settles.
    // The visible repoA pane painted its theme from the start, so nothing re-themed.
    const { runtime, replies } = createResponderRuntime()
    setTerminalViewAttributes(viewAttributes())
    const ptyId = 'repoA::/a@@deadbeef'
    markHiddenRendererPty(ptyId)
    await query(runtime, replies, ptyId, '\x1b]4;1;#00ff00\x07')

    setRepoTerminalViewAttributes({ byHostId: { local: { repoA: repoAttributes() } } })
    expect(await query(runtime, replies, ptyId, '\x1b]4;1;?\x07')).toEqual([
      '\x1b]4;1;rgb:0000/ffff/0000\x1b\\'
    ])
  })

  it('keeps overlays on an identical repo re-push (renderer reload)', async () => {
    const { runtime, replies } = createResponderRuntime()
    runtime.registerPty('pty-a', 'repoA::/a')
    markHiddenRendererPty('pty-a')
    setTerminalViewAttributes(viewAttributes())
    setRepoTerminalViewAttributes({ byHostId: { local: { repoA: repoAttributes() } } })
    await query(runtime, replies, 'pty-a', '\x1b]11;#ffffff\x07')

    setRepoTerminalViewAttributes({ byHostId: { local: { repoA: repoAttributes() } } })
    expect(await query(runtime, replies, 'pty-a', '\x1b]11;?\x07')).toEqual([
      '\x1b]11;rgb:ffff/ffff/ffff\x1b\\'
    ])
  })

  it('keeps overlays through cursor-only repo pushes, other-project pushes and the first empty map', async () => {
    const { runtime, replies } = createResponderRuntime()
    runtime.registerPty('pty-g', 'repoG::/g')
    runtime.registerPty('pty-a', 'repoA::/a')
    markHiddenRendererPty('pty-g')
    markHiddenRendererPty('pty-a')
    setTerminalViewAttributes(viewAttributes())
    await query(runtime, replies, 'pty-g', '\x1b]11;#ffffff\x07')
    setRepoTerminalViewAttributes({ byHostId: {} })
    setRepoTerminalViewAttributes({ byHostId: { local: { repoA: repoAttributes() } } })
    await query(runtime, replies, 'pty-a', '\x1b]11;#ffffff\x07')

    const cursorOnly = { ...repoAttributes(), cursorBlink: false, cursorStyle: 'block' as const }
    setRepoTerminalViewAttributes({ byHostId: { local: { repoA: cursorOnly } } })
    setRepoTerminalViewAttributes({
      byHostId: { local: { repoA: cursorOnly, repoB: repoAttributes() } }
    })
    const white = ['\x1b]11;rgb:ffff/ffff/ffff\x1b\\']
    expect(await query(runtime, replies, 'pty-a', '\x1b]11;?\x07')).toEqual(white)
    expect(await query(runtime, replies, 'pty-g', '\x1b]11;?\x07')).toEqual(white)
  })
})
