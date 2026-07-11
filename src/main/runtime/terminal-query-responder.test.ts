/**
 * Phase 5 model query responder (docs/reference/terminal-query-authority.md):
 * reply parity through the runtime emulator, the per-chunk ownership matrix,
 * the main-side replay guard, and the ingestion-time capture race.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import { HeadlessEmulator } from '../daemon/headless-emulator'
import {
  _resetHiddenRendererPtyDeliveryGateForTest,
  markHiddenRendererPty,
  setRendererPtyDeliveryInterest,
  unmarkHiddenRendererPty
} from '../ipc/pty-hidden-delivery-gate'
import {
  _resetTerminalModelQueryAuthorityForTest,
  markNativeWindowsConptyPty
} from './terminal-model-query-authority'
import {
  _resetTerminalViewAttributesForTest,
  setTerminalViewAttributes
} from './terminal-view-attribute-store'
import type { TerminalViewAttributes, TerminalViewRgb } from '../../shared/terminal-view-attributes'

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
  runtime.setPtyController({
    write: (ptyId, data) => {
      replies.push({ ptyId, data })
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
  return { runtime, replies }
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
  // Expected replies pinned from the design doc and verified against the
  // bundled @xterm/headless build — the same core the renderer runs, so
  // parity is structural for static and model-state classes.
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
    const { runtime, replies } = createResponderRuntime()
    markHiddenRendererPty('pty-q')

    runtime.onPtyData('pty-q', chunk, Date.now())
    await settle(runtime, 'pty-q')

    expect(replies.map((reply) => reply.data)).toEqual(expectedReplies)
    expect(replies.every((reply) => reply.ptyId === 'pty-q')).toBe(true)
  })

  it.each([
    ['XTWINOPS', '\x1b[14t'],
    ['XTGETTCAP', '\x1bP+q544e\x1b\\'],
    ['DSR ?15n printer status', '\x1b[?15n'],
    ['DSR ?25n UDK status', '\x1b[?25n'],
    ['DSR ?26n keyboard status', '\x1b[?26n'],
    ['DSR ?53n locator status', '\x1b[?53n'],
    // View-attribute class: silent until the slice-2 renderer attribute push
    // — a fabricated default would resurrect the default-black OSC-11 bug.
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
  const DA1 = '\x1b[c'

  it('never answers delivered (unmarked) chunks — the visible xterm owns them', async () => {
    const { runtime, replies } = createResponderRuntime()

    runtime.onPtyData('pty-v', DA1, Date.now())
    await settle(runtime, 'pty-v')

    expect(replies).toEqual([])
  })

  it('never answers while renderer delivery interest holds the chunk delivered', async () => {
    const { runtime, replies } = createResponderRuntime()
    markHiddenRendererPty('pty-i')
    setRendererPtyDeliveryInterest('pty-i', true)

    runtime.onPtyData('pty-i', DA1, Date.now())
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
    markHiddenRendererPty('pty-k')

    runtime.onPtyData('pty-k', DA1, Date.now())
    await settle(runtime, 'pty-k')

    expect(replies).toEqual([])
  })

  it('yields while a remote view subscriber is attached and resumes on release', async () => {
    const { runtime, replies } = createResponderRuntime()
    markHiddenRendererPty('pty-r')
    const release = runtime.registerRemoteTerminalViewSubscriber('pty-r')

    runtime.onPtyData('pty-r', DA1, Date.now())
    await settle(runtime, 'pty-r')
    expect(replies).toEqual([])

    release()
    // Releases are idempotent: a double release must not unbalance the count.
    release()
    runtime.onPtyData('pty-r', DA1, Date.now())
    await settle(runtime, 'pty-r')
    expect(replies.map((reply) => reply.data)).toEqual(['\x1b[?1;2c'])
  })

  it('counts overlapping remote view subscribers', () => {
    const { runtime } = createResponderRuntime()
    const releaseA = runtime.registerRemoteTerminalViewSubscriber('pty-m')
    const releaseB = runtime.registerRemoteTerminalViewSubscriber('pty-m')
    expect(runtime.hasRemoteTerminalViewSubscriber('pty-m')).toBe(true)
    releaseA()
    expect(runtime.hasRemoteTerminalViewSubscriber('pty-m')).toBe(true)
    releaseB()
    expect(runtime.hasRemoteTerminalViewSubscriber('pty-m')).toBe(false)
  })

  it('treats mobile subscriber records as remote view subscribers', async () => {
    const { runtime } = createResponderRuntime()
    await runtime.handleMobileSubscribe('pty-mob', 'client-1', { cols: 40, rows: 20 })
    expect(runtime.hasRemoteTerminalViewSubscriber('pty-mob')).toBe(true)
  })

  it('answers a dropped-chunk query exactly once', async () => {
    const { runtime, replies } = createResponderRuntime()
    markHiddenRendererPty('pty-once')

    runtime.onPtyData('pty-once', DA1, Date.now())
    await settle(runtime, 'pty-once')

    expect(replies).toHaveLength(1)
  })
})

describe('main-side replay guard', () => {
  const DA1 = '\x1b[c'

  it('never answers queries embedded in a seeded snapshot, then answers live bytes', async () => {
    const { runtime, replies } = createResponderRuntime()
    markHiddenRendererPty('pty-seed')

    runtime.seedHeadlessTerminal('pty-seed', `restored prompt${DA1}`)
    await settle(runtime, 'pty-seed')
    expect(replies).toEqual([])

    runtime.onPtyData('pty-seed', DA1, Date.now())
    await settle(runtime, 'pty-seed')
    expect(replies.map((reply) => reply.data)).toEqual(['\x1b[?1;2c'])
  })

  it('never answers queries replayed by renderer-buffer hydration', async () => {
    const { runtime, replies } = createResponderRuntime({
      rendererBuffer: { data: `restored screen${DA1}`, cols: 80, rows: 24 }
    })
    markHiddenRendererPty('pty-hyd')

    // First live byte triggers maybeHydrateHeadlessFromRenderer; the hydration
    // seed parses the embedded DA1 but must not forward its reply.
    runtime.onPtyData('pty-hyd', 'live output', Date.now())
    await settle(runtime, 'pty-hyd')

    expect(replies).toEqual([])
  })
})

describe('kitty flag re-seed parity (terminal-query-authority.md §kitty)', () => {
  it('answers ?u with the persisted snapshot flags after a re-seed, silently applied', async () => {
    const { runtime, replies } = createResponderRuntime()
    markHiddenRendererPty('pty-kitty')

    // Daemon warm-reattach threads modes.kittyKeyboardFlags through the
    // spawn result into the seed; applying them is a seed-side write and
    // must answer no one (main-side replay guard).
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

  it('keeps the override single-reply when installed at creation and marked again', async () => {
    const { runtime, replies } = createResponderRuntime()
    markNativeWindowsConptyPty('pty-win-idem')
    markHiddenRendererPty('pty-win-idem')

    runtime.onPtyData('pty-win-idem', 'boot output', Date.now())
    // A duplicate mark (e.g. respawn against a live emulator) must not stack
    // a second handler that double-replies.
    markNativeWindowsConptyPty('pty-win-idem')

    runtime.onPtyData('pty-win-idem', '\x1b[c', Date.now())
    await settle(runtime, 'pty-win-idem')

    expect(replies.map((reply) => reply.data)).toEqual(['\x1b[?61;4c'])
  })

  it('answers CSI ?61;4c for marked native-Windows PTYs, suppressing the core ?1;2c', async () => {
    const { runtime, replies } = createResponderRuntime()
    markNativeWindowsConptyPty('pty-win')
    markHiddenRendererPty('pty-win')

    runtime.onPtyData('pty-win', '\x1b[c', Date.now())
    await settle(runtime, 'pty-win')

    expect(replies.map((reply) => reply.data)).toEqual(['\x1b[?61;4c'])
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
    // Force the async write path (xterm deprecates writeSync; the fallback
    // must stay structurally safe without writeChain serialization).
    const internals = emulator as unknown as { terminal: { _core: { writeSync?: unknown } } }
    internals.terminal._core.writeSync = undefined
    try {
      // Enqueue an unflagged seed carrying a query, then a flagged live
      // chunk, WITHOUT awaiting between them: both sit in xterm's write
      // queue together. The seed parse must not see an open window.
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
  // Reply bytes pinned to the renderer xterm's format: OSC replies use the
  // queried ident, 16-bit doubled-byte channels, and ST termination
  // (CoreBrowserTerminal._handleColorEvent + toRgbString); ?996n answers with
  // the contour 997 report, same bytes as mode2031SequenceFor.
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
    // Supported divergence: light app mode with terminalUseSeparateLightTheme
    // off renders a dark terminal theme. A visible xterm answers ?996n from
    // bg/fg relative luminance (CoreBrowserTerminal._reportColorScheme), so
    // the hidden reply must say dark here too.
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
    expect(replies.map((reply) => reply.data).at(-1)).toBe('\x1bP1$r4 q\x1b\\')
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
    // Cold-restore scrollback replayed into a visible renderer xterm re-applies
    // OSC SETs to its theme service; the model mirrors that state — but the
    // replay guard still keeps the seed from ANSWERING anything.
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

    // A second window / renderer reload / macOS re-activation re-pushes
    // byte-identical attributes (its publisher dedupe is per-process). That is
    // not a theme apply, so the OSC SET overlay must survive.
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

    // A theme apply overwrites OSC-SET-mutated colors on visible panes too
    // (ThemeService._setTheme), so the model mirrors that on every CHANGED
    // push (identical re-pushes are filtered — see the test above).
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
