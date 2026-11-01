import { afterEach, expect, it, vi } from 'vitest'
import { findAgentInputDialogIndex } from '../../shared/agent-input-dialog'
import { finalReplayFrame } from './agent-transcript-replay-test-harness'
import { TUI_AGENT_CONFIG } from '../../shared/tui-agent-config'
import { waitForWorktreeStartupDraft } from './runtime-worktree-startup-readiness'

afterEach(() => vi.useRealTimers())

it.each([
  'antigravity-busy-mid-turn',
  'antigravity-busy-turn-ended',
  'antigravity-1-2-14-busy-thinking',
  'antigravity-1-2-14-busy-streaming',
  'cline-3-0-66-busy-streaming'
])('preserves generated followups on the recorded busy footer: %s', async (name) => {
  const { ruledScreenLines } = await finalReplayFrame(name, 120, 40)
  expect(
    findAgentInputDialogIndex(ruledScreenLines.join('\n')),
    ruledScreenLines.join('\n')
  ).toBeNull()
  vi.useFakeTimers()
  const agent = name.startsWith('cline') ? 'cline' : 'antigravity'
  const result = waitForWorktreeStartupDraft(
    {
      getPtyId: () => 'busy-agent',
      getForegroundProcess: async () => TUI_AGENT_CONFIG[agent].expectedProcess,
      subscribeToData: () => () => {},
      readRecentOutput: () => undefined,
      readInputScreen: async () => ruledScreenLines,
      write: vi.fn()
    },
    'handle',
    agent,
    { submit: true }
  )
  await vi.advanceTimersByTimeAsync(1650)
  await expect(result).resolves.toBe('busy-agent')
})

it('delivers to a recorded default-quiet composer on late attach with no 2004 replay', async () => {
  const { ruledScreenLines } = await finalReplayFrame('cline-3-0-66-ready', 120, 40)
  vi.useFakeTimers()
  const result = waitForWorktreeStartupDraft(
    {
      getPtyId: () => 'late-cline',
      getForegroundProcess: async () => 'cline',
      subscribeToData: () => () => {},
      readRecentOutput: () => undefined,
      readInputScreen: async () => ruledScreenLines,
      write: vi.fn()
    },
    'handle',
    'cline',
    { submit: true }
  )
  await vi.advanceTimersByTimeAsync(1650)
  await expect(result).resolves.toBe('late-cline')
})

it('recognizes recorded trust ownership and the later answered composer', async () => {
  const dialog = await finalReplayFrame('claude-dialog-trust-workspace', 120, 40)
  const answered = await finalReplayFrame('claude-dialog-trust-workspace-answered', 120, 40)
  expect(findAgentInputDialogIndex(dialog.ruledScreenLines.join('\n'))).not.toBeNull()
  expect(findAgentInputDialogIndex(answered.ruledScreenLines.join('\n'))).toBeNull()
})

it('recognizes bypass selection rows without treating the selected option as a composer', () => {
  expect(
    findAgentInputDialogIndex(
      'Bypass Permissions\n❯ 1. No, exit\n  2. Yes, I accept\nEnter to confirm · Esc to cancel'
    )
  ).not.toBeNull()
  expect(findAgentInputDialogIndex('quoted Esc to cancel\n❯\u00a0')).toBeNull()
})

it('does not confuse a cancellable input dialog with a running-turn footer', () => {
  expect(findAgentInputDialogIndex('Enter your API key\n❯ \nEsc to cancel')).not.toBeNull()
})
