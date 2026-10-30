import './rpc/unused-default-rpc-methods.test-fixture'
import { afterEach, expect, it, vi } from 'vitest'
import { runtimeWithLeaf } from './orca-runtime-pty-leaf.test-fixture'
import { evaluateTuiIdle } from './tui-idle-evidence'
import { ptyTuiIdleEvidence } from './tui-idle-evidence-source'

const PTY_ID = 'repo-1::/tmp/wt@@1a2b3c4d'
const CODEX_COMPOSER = '› Ask Codex to do anything'

afterEach(() => {
  vi.useRealTimers()
})

it('a silent reattached Codex reads quiet on its PTY, and stays quiet when its pane mounts', () => {
  vi.useFakeTimers({ now: 100_000 })
  const { runtime } = runtimeWithLeaf(PTY_ID)
  runtime.seedTerminalRestoreTail(PTY_ID, { text: CODEX_COMPOSER })
  runtime.startReattachedOutputClock(PTY_ID)
  const pty = runtime['ptysById'].get(PTY_ID)!
  const source = {
    ...runtime['tuiIdleEvidenceSource'],
    getPaneAgent: () => 'codex' as const,
    readScreenLines: () => [CODEX_COMPOSER],
    readRuledScreen: () => ({ lines: [CODEX_COMPOSER], alternateScreen: false })
  }
  const verdict = () => evaluateTuiIdle(ptyTuiIdleEvidence(source, pty, () => pty.preview)).kind

  expect(verdict()).toBe('pending')
  vi.advanceTimersByTime(source.quiescenceMs)
  // The PTY never saw output; the clock is main's observation since the reattach.
  expect(pty.lastOutputAt).toBeNull()
  expect(verdict()).toBe('ready-strong')
  // A pane mounting later reattaches the same process; its observed quiet must not restart.
  runtime.startReattachedOutputClock(PTY_ID)
  expect(verdict()).toBe('ready-strong')
})
