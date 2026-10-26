/** Verify emulator reply parity, per-chunk ownership, replay silence and capture races. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import { HeadlessEmulator } from '../daemon/headless-emulator'
import {
  _resetHiddenRendererPtyDeliveryGateForTest,
  markHiddenRendererPty,
  setRendererPtyDeliveryInterest,
  unmarkHiddenRendererPty
} from '../ipc/pty/delivery/pty-hidden-delivery-gate'
import {
  _resetTerminalModelQueryAuthorityForTest,
  markNativeWindowsConptyPty
} from './terminal-model-query-authority'
import {
  _resetTerminalViewAttributesForTest,
  setTerminalViewAttributes
} from './terminal-view-attribute-store'
import type { TerminalViewAttributes, TerminalViewRgb } from '../../shared/terminal-view-attributes'
import type { TerminalInputKind } from '../../shared/terminal-input-kind'

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

describe('reply parity for hidden-dropped chunks', () => {
  // Pin design replies against bundled xterm/headless, which shares renderer core.
  it.each([
    ['DA1 CSI c', '\x1b[c', ['\x1b[?1;2c']],
    ['DA1 CSI 0 c variant', '\x1b[0c', ['\x1b[?1;2c']],
    ['DA2', '\x1b[>c', ['\x1b[>0;276;0c']],
    ['DSR 5n operating status', '\x1b[5n', ['\x1b[0n']],
    ['CPR 6n at origin', '\x1b[6n', ['\x1b[1;1R']],
    ['CPR 6n reports the model cursor position', 'hello\r\nworld\x1b[6n', ['\x1b[2;6R']],
    ['DECXCPR ?6n', '\x1b[?6n', ['\x1b[?1;1R']],
    ['DECRPM ?1 DECCKM default', '\x1b[?1$p', ['\x1b[?1;2$y']],
    ['DECRPM ?6 DECOM default', '\x1b[?6$p', ['\x1b[?6;2$y']],
    ['DECRPM ?7 DECAWM default', '\x1b[?7$p', ['\x1b[?7;1$y']],
    ['DECRPM ?25 DECTCEM default', '\x1b[?25$p', ['\x1b[?25;1$y']],
    ['DECRPM ?1004 focus events default', '\x1b[?1004$p', ['\x1b[?1004;2$y']],
    ['DECRPM ?1006 SGR mouse default', '\x1b[?1006$p', ['\x1b[?1006;2$y']],
    ['DECRPM ?1016 SGR pixels default', '\x1b[?1016$p', ['\x1b[?1016;2$y']],
    ['DECRPM ?1049 alt screen default', '\x1b[?1049$p', ['\x1b[?1049;2$y']],
    ['DECRPM ?2004 bracketed paste default', '\x1b[?2004$p', ['\x1b[?2004;2$y']],
    ['DECRPM ?2026 synchronized output default', '\x1b[?2026$p', ['\x1b[?2026;2$y']],
    ['DECRPM reports a set mode as enabled', '\x1b[?2004h\x1b[?2004$p', ['\x1b[?2004;1$y']],
    ['DECRPM unknown mode reports 0', '\x1b[?12345$p', ['\x1b[?12345;0$y']],
    ['DECRQM ANSI insert mode', '\x1b[4$p', ['\x1b[4;2$y']],
    ['DECRQSS DECSTBM default margins', '\x1bP$qr\x1b\\', ['\x1bP1$r1;24r\x1b\\']],
    ['DECRQSS DECSTBM after margin set', '\x1b[5;20r\x1bP$qr\x1b\\', ['\x1bP1$r5;20r\x1b\\']],
    ['DECRQSS DECSCUSR default cursor', '\x1bP$q q\x1b\\', ['\x1bP1$r2 q\x1b\\']],
    ['DECRQSS DECSCA', '\x1bP$q"q\x1b\\', ['\x1bP1$r0"q\x1b\\']],
    ['DECRQSS SGR', '\x1bP$qm\x1b\\', ['\x1bP1$r0m\x1b\\']],
    ['XTVERSION', '\x1b[>0q', ['\x1bP>|xterm.js(6.0.0)\x1b\\']],
    ['kitty CSI ? u default flags', '\x1b[?u', ['\x1b[?0u']],
    ['kitty CSI ? u reports pushed flags', '\x1b[=5;1u\x1b[?u', ['\x1b[?5u']]
  ])('%s', async (_label, chunk, expectedReplies) => {
    const { runtime, replies, inputKinds } = createResponderRuntime()
    markHiddenRendererPty('pty-q')

    runtime.onPtyData('pty-q', chunk, Date.now())
    await settle(runtime, 'pty-q')

    expect(replies.map((reply) => reply.data)).toEqual(expectedReplies)
    expect(replies.every((reply) => reply.ptyId === 'pty-q')).toBe(true)
    // Why: a reply written as driving input would read the untouched run as typed.
    expect(inputKinds).toEqual(expectedReplies.map(() => 'query-reply'))
  })

  it.each([
    ['XTWINOPS', '\x1b[14t'],
    ['XTGETTCAP', '\x1bP+q544e\x1b\\'],
    ['DSR ?15n printer status', '\x1b[?15n'],
    ['DSR ?25n UDK status', '\x1b[?25n'],
    ['DSR ?26n keyboard status', '\x1b[?26n'],
    ['DSR ?53n locator status', '\x1b[?53n'],
    // No renderer attributes means silence; fabricated colors would revive the default-black OSC-11 bug.
    ['OSC 10 foreground query', '\x1b]10;?\x07'],
    ['OSC 11 background query', '\x1b]11;?\x07'],
    ['OSC 12 cursor-color query', '\x1b]12;?\x1b\\'],
    ['OSC 4 palette query', '\x1b]4;1;?\x07'],
    ['DSR ?996n color-scheme query', '\x1b[?996n']
  ])('stays silent for %s', async (_label, chunk) => {
    const { runtime, replies } = createResponderRuntime()
    markHiddenRendererPty('pty-q')

    runtime.onPtyData('pty-q', chunk, Date.now())
    await settle(runtime, 'pty-q')

    expect(replies).toEqual([])
  })
})

describe('reply ownership matrix', () => {
  it('never answers delivered (unmarked) chunks — the visible xterm owns them', async () => {
    const { runtime, replies } = createResponderRuntime()
    setTerminalViewAttributes(viewAttributes())

    runtime.onPtyData('pty-v', QUERY_BATCH, Date.now())
    await settle(runtime, 'pty-v')

    expect(replies).toEqual([])
  })

  it('never answers while renderer delivery interest holds the chunk delivered', async () => {
    const { runtime, replies } = createResponderRuntime()
    setTerminalViewAttributes(viewAttributes())
    markHiddenRendererPty('pty-i')
    setRendererPtyDeliveryInterest('pty-i', true)

    runtime.onPtyData('pty-i', QUERY_BATCH, Date.now())
    await settle(runtime, 'pty-i')

    expect(replies).toEqual([])
  })

  it.each([
    ['terminalModelQueryAuthority', () => (settingsState.terminalModelQueryAuthority = false)],
    ['terminalHiddenDeliveryGate', () => (settingsState.terminalHiddenDeliveryGate = false)],
    [
      'terminalMainSideEffectAuthority',
      () => (settingsState.terminalMainSideEffectAuthority = false)
    ]
  ])('never answers with kill switch %s off', async (_label, flip) => {
    flip()
    const { runtime, replies } = createResponderRuntime()
    setTerminalViewAttributes(viewAttributes())
    markHiddenRendererPty('pty-k')

    runtime.onPtyData('pty-k', QUERY_BATCH, Date.now())
    await settle(runtime, 'pty-k')

    expect(replies).toEqual([])
  })

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

  // #32944: a paused view's discarded queries fall back to main only when that view alone owned them.
  it('reports sole remote query ownership and answers yielded stateless queries', async () => {
    const { runtime, replies } = createResponderRuntime()
    markHiddenRendererPty('pty-yield')
    const releaseA = runtime.registerRemoteTerminalViewSubscriber('pty-yield', () => false)
    expect(runtime.isSoleRemoteTerminalQueryOwner('pty-yield')).toBe(true)
    const releaseB = runtime.registerRemoteTerminalViewSubscriber('pty-yield', () => false)
    expect(runtime.isSoleRemoteTerminalQueryOwner('pty-yield')).toBe(false)
    releaseB()
    releaseA()

    runtime.onPtyData('pty-yield', 'prompt', 0)
    runtime.answerYieldedTerminalQueries('pty-yield', '\x1b[c')
    await settle(runtime, 'pty-yield')
    expect(replies.map((reply) => reply.data)).toEqual(['\x1b[?1;2c'])
  })

  it('keeps raw preview presence separate from terminal query authority', async () => {
    const { runtime, replies } = createResponderRuntime()
    markHiddenRendererPty('pty-preview')
    const release = runtime.registerRawTerminalViewSubscriber('pty-preview')

    expect(runtime.hasRawTerminalViewSubscriber('pty-preview')).toBe(true)
    expect(runtime.hasRemoteTerminalViewSubscriber('pty-preview')).toBe(false)
    runtime.onPtyData('pty-preview', '\x1b[c', Date.now())
    await settle(runtime, 'pty-preview')
    expect(replies.map((reply) => reply.data)).toEqual(['\x1b[?1;2c'])

    release()
    expect(runtime.hasRawTerminalViewSubscriber('pty-preview')).toBe(false)
  })

  it('treats mobile subscriber records as remote view subscribers', async () => {
    const { runtime } = createResponderRuntime()
    await runtime.handleMobileSubscribe('pty-mob', 'client-1', { cols: 40, rows: 20 })
    expect(runtime.hasRemoteTerminalViewSubscriber('pty-mob')).toBe(true)
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

  it('never answers queries replayed by renderer-buffer hydration', async () => {
    setTerminalViewAttributes(viewAttributes())
    const { runtime, replies } = createResponderRuntime({
      rendererBuffer: { data: `restored screen${QUERY_BATCH}`, cols: 80, rows: 24 }
    })
    markHiddenRendererPty('pty-hyd')

    // Hydrated snapshots must not answer embedded terminal queries.
    runtime.onPtyData('pty-hyd', 'live output', Date.now())
    await settle(runtime, 'pty-hyd')

    expect(replies).toEqual([])
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

  it('answers ?0u when the snapshot carried no flags (fresh-shell paths)', async () => {
    const { runtime, replies } = createResponderRuntime()
    markHiddenRendererPty('pty-kitty0')

    runtime.seedHeadlessTerminal('pty-kitty0', 'restored prompt')
    runtime.onPtyData('pty-kitty0', '\x1b[?u', Date.now())
    await settle(runtime, 'pty-kitty0')

    expect(replies.map((reply) => reply.data)).toEqual(['\x1b[?0u'])
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

  it('stays silent when the hidden mark lands after ingestion', async () => {
    const { runtime, replies } = createResponderRuntime()

    runtime.onPtyData('pty-race2', DA1, Date.now())
    markHiddenRendererPty('pty-race2')
    await settle(runtime, 'pty-race2')

    expect(replies).toEqual([])
  })
})

describe('stale writeChain links after dispose', () => {
  const DA1 = '\x1b[c'

  it('never forwards a queued reply once the PTY state is disposed', async () => {
    const { runtime, replies } = createResponderRuntime()
    markHiddenRendererPty('pty-stale')

    // Queue a forward-flagged chain link, then dispose before it runs.
    runtime.onPtyData('pty-stale', DA1, Date.now())
    runtime.onPtyExit('pty-stale', 0)
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(replies).toEqual([])
  })

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

  it('answers once at creation and after a repeated native-Windows mark', async () => {
    const { runtime, replies } = createResponderRuntime()
    markNativeWindowsConptyPty('pty-win-idem')
    markHiddenRendererPty('pty-win-idem')

    runtime.onPtyData('pty-win-idem', '\x1b[c', Date.now())
    await settle(runtime, 'pty-win-idem')
    expect(replies.map((reply) => reply.data)).toEqual(['\x1b[?61;4c'])

    markNativeWindowsConptyPty('pty-win-idem')
    runtime.onPtyData('pty-win-idem', '\x1b[c', Date.now())
    await settle(runtime, 'pty-win-idem')
    expect(replies.map((reply) => reply.data)).toEqual(['\x1b[?61;4c', '\x1b[?61;4c'])
  })

  it('lets non-primary device-attribute queries fall through to the core', async () => {
    const { runtime, replies } = createResponderRuntime()
    markNativeWindowsConptyPty('pty-win2')
    markHiddenRendererPty('pty-win2')

    runtime.onPtyData('pty-win2', '\x1b[>c', Date.now())
    await settle(runtime, 'pty-win2')

    expect(replies.map((reply) => reply.data)).toEqual(['\x1b[>0;276;0c'])
  })

  it('keeps the override silent for delivered chunks', async () => {
    const { runtime, replies } = createResponderRuntime()
    markNativeWindowsConptyPty('pty-win3')

    runtime.onPtyData('pty-win3', '\x1b[c', Date.now())
    await settle(runtime, 'pty-win3')

    expect(replies).toEqual([])
  })
})

describe('HeadlessEmulator forwarding window', () => {
  it('forwards replies only for writes flagged forwardQueryReplies', async () => {
    const onQueryReply = vi.fn()
    const emulator = new HeadlessEmulator({ cols: 80, rows: 24, onQueryReply })
    try {
      await emulator.write('\x1b[c')
      expect(onQueryReply).not.toHaveBeenCalled()

      await emulator.write('\x1b[c', { forwardQueryReplies: true })
      expect(onQueryReply).toHaveBeenCalledTimes(1)
      expect(onQueryReply).toHaveBeenCalledWith('\x1b[?1;2c')
    } finally {
      emulator.dispose()
    }
  })

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
  // Match renderer xterm: queried OSC id, doubled-byte 16-bit RGB and ST; ?996n uses contour 997 (CoreBrowserTerminal._handleColorEvent/toRgbString).
  it.each([
    ['OSC 10 foreground', '\x1b]10;?\x07', ['\x1b]10;rgb:d0d0/d0d0/d0d0\x1b\\']],
    ['OSC 11 background', '\x1b]11;?\x07', ['\x1b]11;rgb:1e1e/1e1e/2e2e\x1b\\']],
    ['OSC 12 cursor color', '\x1b]12;?\x1b\\', ['\x1b]12;rgb:ffff/9999/0000\x1b\\']],
    ['OSC 4 named palette slot', '\x1b]4;1;?\x07', ['\x1b]4;1;rgb:cccc/0000/0000\x1b\\']],
    ['OSC 4 extended palette slot', '\x1b]4;196;?\x07', ['\x1b]4;196;rgb:c4c4/8888/4c4c\x1b\\']],
    [
      'OSC 4 multiple slots in one sequence',
      '\x1b]4;1;?;196;?\x07',
      ['\x1b]4;1;rgb:cccc/0000/0000\x1b\\', '\x1b]4;196;rgb:c4c4/8888/4c4c\x1b\\']
    ],
    [
      'OSC 10 stacked params report foreground then background',
      '\x1b]10;?;?\x07',
      ['\x1b]10;rgb:d0d0/d0d0/d0d0\x1b\\', '\x1b]11;rgb:1e1e/1e1e/2e2e\x1b\\']
    ],
    ['DSR ?996n dark', '\x1b[?996n', ['\x1b[?997;1n']],
    ['DECRQSS DECSCUSR from pushed cursor options', '\x1bP$q q\x1b\\', ['\x1bP1$r5 q\x1b\\']],
    ['DECRQM ?12 from pushed cursorBlink', '\x1b[?12$p', ['\x1b[?12;1$y']]
  ])('%s', async (_label, chunk, expectedReplies) => {
    const { runtime, replies } = createResponderRuntime()
    markHiddenRendererPty('pty-view')
    setTerminalViewAttributes(viewAttributes())

    runtime.onPtyData('pty-view', chunk, Date.now())
    await settle(runtime, 'pty-view')

    expect(replies.map((reply) => reply.data)).toEqual(expectedReplies)
  })

  it('answers ?996n from palette luminance, not the pushed app mode (dark palette, light app mode)', async () => {
    const { runtime, replies } = createResponderRuntime()
    markHiddenRendererPty('pty-lum-dark')
    // Separate-light-theme off can leave dark terminal colors in light app mode; match xterm luminance-based ?996n.
    setTerminalViewAttributes(viewAttributes({ colorSchemeMode: 'light' }))

    runtime.onPtyData('pty-lum-dark', '\x1b[?996n', Date.now())
    await settle(runtime, 'pty-lum-dark')

    expect(replies.map((reply) => reply.data)).toEqual(['\x1b[?997;1n'])
  })

  it('answers ?996n light for a light palette regardless of the pushed app mode', async () => {
    const { runtime, replies } = createResponderRuntime()
    markHiddenRendererPty('pty-lum-light')
    setTerminalViewAttributes(
      viewAttributes({
        foreground: [0x33, 0x33, 0x33],
        background: [0xfa, 0xfa, 0xfa],
        colorSchemeMode: 'dark'
      })
    )

    runtime.onPtyData('pty-lum-light', '\x1b[?996n', Date.now())
    await settle(runtime, 'pty-lum-light')

    expect(replies.map((reply) => reply.data)).toEqual(['\x1b[?997;2n'])
  })

  it('answers ?996n from OSC-SET-mutated colors like a visible xterm', async () => {
    // _reportColorScheme reads the CURRENT theme-service colors, which include
    // OSC 10/11 SET mutations — the per-PTY overlays layer the same way.
    const { runtime, replies } = createResponderRuntime()
    markHiddenRendererPty('pty-lum-set')
    setTerminalViewAttributes(viewAttributes())

    runtime.onPtyData('pty-lum-set', '\x1b]11;#ffffff\x07\x1b]10;#101010\x07\x1b[?996n', Date.now())
    await settle(runtime, 'pty-lum-set')

    expect(replies.map((reply) => reply.data)).toEqual(['\x1b[?997;2n'])
  })

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

  it('retrofits cursor options onto already-live emulators when the push lands late', async () => {
    const { runtime, replies } = createResponderRuntime()
    markHiddenRendererPty('pty-late')

    // Emulator exists before any push: core default DECSCUSR is steady block.
    runtime.onPtyData('pty-late', '\x1bP$q q\x1b\\', Date.now())
    await settle(runtime, 'pty-late')
    expect(replies.map((reply) => reply.data)).toEqual(['\x1bP1$r2 q\x1b\\'])

    setTerminalViewAttributes(viewAttributes({ cursorStyle: 'underline', cursorBlink: false }))
    runtime.onPtyData('pty-late', '\x1bP$q q\x1b\\', Date.now())
    await settle(runtime, 'pty-late')
    expect(replies.map((reply) => reply.data)).toEqual(['\x1bP1$r2 q\x1b\\', '\x1bP1$r4 q\x1b\\'])
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

  it('restores a single indexed color via OSC 104;<idx>', async () => {
    const { runtime, replies } = createResponderRuntime()
    markHiddenRendererPty('pty-104')
    setTerminalViewAttributes(viewAttributes())

    runtime.onPtyData('pty-104', '\x1b]4;1;#00ff00\x07\x1b]104;1\x07\x1b]4;1;?\x07', Date.now())
    await settle(runtime, 'pty-104')

    expect(replies.map((reply) => reply.data)).toEqual(['\x1b]4;1;rgb:cccc/0000/0000\x1b\\'])
  })

  it('restores the whole indexed table via bare OSC 104', async () => {
    const { runtime, replies } = createResponderRuntime()
    markHiddenRendererPty('pty-104all')
    setTerminalViewAttributes(viewAttributes())

    runtime.onPtyData(
      'pty-104all',
      '\x1b]4;1;#00ff00;196;#0000ff\x07\x1b]104\x07\x1b]4;1;?;196;?\x07',
      Date.now()
    )
    await settle(runtime, 'pty-104all')

    expect(replies.map((reply) => reply.data)).toEqual([
      '\x1b]4;1;rgb:cccc/0000/0000\x1b\\',
      '\x1b]4;196;rgb:c4c4/8888/4c4c\x1b\\'
    ])
  })

  it('layers OSC 10/11/12 SETs and restores them via 110/111/112', async () => {
    const { runtime, replies } = createResponderRuntime()
    markHiddenRendererPty('pty-special')
    setTerminalViewAttributes(viewAttributes())

    runtime.onPtyData(
      'pty-special',
      '\x1b]10;#010203\x07\x1b]11;rgb:ff/ff/ff\x07\x1b]12;#0a0b0c\x07' +
        '\x1b]10;?\x07\x1b]11;?\x07\x1b]12;?\x07' +
        '\x1b]110\x07\x1b]111\x07\x1b]112\x07' +
        '\x1b]10;?\x07\x1b]11;?\x07\x1b]12;?\x07',
      Date.now()
    )
    await settle(runtime, 'pty-special')

    expect(replies.map((reply) => reply.data)).toEqual([
      '\x1b]10;rgb:0101/0202/0303\x1b\\',
      '\x1b]11;rgb:ffff/ffff/ffff\x1b\\',
      '\x1b]12;rgb:0a0a/0b0b/0c0c\x1b\\',
      '\x1b]10;rgb:d0d0/d0d0/d0d0\x1b\\',
      '\x1b]11;rgb:1e1e/1e1e/2e2e\x1b\\',
      '\x1b]12;rgb:ffff/9999/0000\x1b\\'
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
