import { afterEach, describe, expect, it } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import {
  _resetPtyColorSchemeReplyGateForTest,
  shouldDropStalePtyColorSchemeReply
} from './pty-color-scheme-reply-write-gate'

// Regression for #9993 (still reproducible on v1.4.168, after #8206/#8214/#10817):
// `^[[?997;1n^[[?997;1n` lands in the stdin of whatever runs next after every
// fish prompt-accept, corrupting interactive prompts (brew/npx `[y/N]` etc).
//
// Byte-level ground truth, captured from fish 4.7.1 + Tide behind a nested PTY
// inside an Orca 1.4.168 terminal: at command accept fish toggles mode 2031
// once per repaint, each toggle its own PTY chunk, five chunks in ~5ms —
//
//   T+5.056  fish  ?2004l ?2031l          (withdraw)
//   T+5.056  fish  ?2004h ?2031h          (re-subscribe — chunk ends subscribed)
//   T+5.058  fish  ?2004l ?2031l          (withdraw)
//   T+5.058  orca  CSI ?997;1n            (reply to 5.056h — stale on arrival)
//   T+5.060  fish  OSC 0 + ?2004h ?2031h  (re-subscribe)
//   T+5.060  fish  ?2004l ?2031l + 133;C  (final withdraw, command starts)
//   T+5.061  orca  CSI ?997;1n            (reply to 5.060h — stale on arrival)
//
// Every responder decision was correct for the chunk it saw (#10817's
// chunk-final contract holds); the replies lose to the NEXT chunk because they
// cross a scheduling boundary (renderer IPC / remote protocol) before reaching
// the PTY. Main ingests output ahead of every reply route, so the write gate
// re-checks subscription state where the bytes enter the PTY.

const PTY_ID = 'pty-9993'
const DARK_REPORT = '\x1b[?997;1n'

// fish 4.7.1 tty_handoff toggle chunks, verbatim from the trace.
const FISH_WITHDRAW = '\x1b[?2004l\x1b[?2031l\x1b[>4;0m\x1b>'
const FISH_RESUBSCRIBE = '\x1b[?2004h\x1b[?2031h\x1b[>4;1m\x1b='
const FISH_TITLED_RESUBSCRIBE =
  '\x1b]0;~/p/example-repo\x07\x1b[m\x1b[?2004h\x1b[?2031h\x1b[>4;1m\x1b=\r'
const FISH_FINAL_WITHDRAW =
  '\x1b[?2004l\x1b[?2031l\x1b[>4;0m\x1b>\r\n\x1b[m\x1b]133;C;cmdline_url=echo%20hi\x07'

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
    terminalMainSideEffectAuthority: true,
    terminalHiddenDeliveryGate: true,
    terminalModelQueryAuthority: true
  })
}

function createScanningRuntime(): OrcaRuntimeService {
  const runtime = new OrcaRuntimeService(store, undefined, {
    onTerminalSideEffects: () => {}
  })
  // Why: transient scanners (incl. mode 2031) only run once a fact consumer
  // exists — mirror a desktop renderer attaching.
  runtime.attachWindow(1)
  runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
  return runtime
}

afterEach(() => {
  _resetPtyColorSchemeReplyGateForTest()
})

describe('issue #9993: stale mode-2031 replies at fish prompt accept', () => {
  it('drops both replies of the accept burst once newer chunks withdrew', () => {
    const runtime = createScanningRuntime()
    let at = 100
    runtime.onPtyData(PTY_ID, FISH_WITHDRAW, at++)
    runtime.onPtyData(PTY_ID, FISH_RESUBSCRIBE, at++)
    runtime.onPtyData(PTY_ID, FISH_WITHDRAW, at++)
    // The reply decided from the re-subscribe chunk arrives only now.
    expect(shouldDropStalePtyColorSchemeReply(PTY_ID, DARK_REPORT)).toBe(true)

    runtime.onPtyData(PTY_ID, FISH_TITLED_RESUBSCRIBE, at++)
    runtime.onPtyData(PTY_ID, FISH_FINAL_WITHDRAW, at++)
    // Second late reply — the doubled `^[[?997;1n^[[?997;1n` from the report.
    expect(shouldDropStalePtyColorSchemeReply(PTY_ID, DARK_REPORT)).toBe(true)
  })

  it('passes the reply while fish still sits subscribed at the prompt', () => {
    const runtime = createScanningRuntime()
    runtime.onPtyData(PTY_ID, FISH_TITLED_RESUBSCRIBE, 100)
    expect(shouldDropStalePtyColorSchemeReply(PTY_ID, DARK_REPORT)).toBe(false)
  })

  it('feeds the gate from daemon-relayed 2031 facts even with no fact consumer', () => {
    // Delegated scan authority: the daemon relays the withdrawal as a fact.
    // The gate must learn it before any consumer gating — a queued reply can
    // cross the write boundary regardless of consumer availability.
    const runtime = new OrcaRuntimeService(store)
    runtime.emitDaemonPtyTransientFact(PTY_ID, { kind: '2031-subscribe' })
    expect(shouldDropStalePtyColorSchemeReply(PTY_ID, DARK_REPORT)).toBe(false)
    runtime.emitDaemonPtyTransientFact(PTY_ID, { kind: '2031-unsubscribe' })
    expect(shouldDropStalePtyColorSchemeReply(PTY_ID, DARK_REPORT)).toBe(true)
  })

  it('still answers a ?996n one-shot query after fish withdrew', () => {
    const runtime = createScanningRuntime()
    runtime.onPtyData(PTY_ID, FISH_RESUBSCRIBE, 100)
    runtime.onPtyData(PTY_ID, FISH_WITHDRAW, 101)
    runtime.onPtyData(PTY_ID, '\x1b[?996n', 102)
    // The DSR answer reuses the CSI 997 bytes; exactly one must pass.
    expect(shouldDropStalePtyColorSchemeReply(PTY_ID, DARK_REPORT)).toBe(false)
    expect(shouldDropStalePtyColorSchemeReply(PTY_ID, DARK_REPORT)).toBe(true)
  })
})
