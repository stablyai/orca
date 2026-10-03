import { makeAgentStatusStoreWiring } from './agent-status-store-wiring.test-fixture'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createTranscriptPane, TRANSCRIPT_PANE_PTY_ID } from './agent-transcript-pane-test-harness'
import { finalReplayFrame } from './agent-transcript-replay-test-harness'
import { evaluateAgentStateRules } from './agent-state-rules/agent-state-rules-engine'
import { isAntigravityCommandApprovalScreen } from './antigravity-command-approval-screen'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp') }
}))

describe('captured native Windows Antigravity command approval', () => {
  it.each(['approval', 'cancelled', 'allow-key'] as const)(
    'reads the recorded %s screen through the current rules',
    async (name) => {
      const { ruledScreenLines } = await finalReplayFrame(
        `antigravity-windows-command-${name}`,
        120,
        40
      )
      expect(isAntigravityCommandApprovalScreen(ruledScreenLines)).toBe(name === 'approval')
      expect(
        evaluateAgentStateRules('antigravity', { readScreenLines: () => ruledScreenLines })
      ).toMatchObject(
        name === 'approval' ? { state: 'hold' } : { state: 'idle', requiresQuiet: true }
      )
    }
  )
})

it.each([
  ['antigravity-windows-command-cancelled', 'done'],
  ['antigravity-busy-mid-turn', 'working'],
  ['antigravity-windows-approved-command-running', 'working']
] as const)('publishes permission then the captured %s state', async (capture, state) => {
  const wiring = makeAgentStatusStoreWiring()
  const { runtime, handle } = await createTranscriptPane(
    {
      paneTitle: 'agy',
      foregroundProcess: 'agy',
      size: { cols: 120, rows: 40 },
      data: ''
    },
    wiring.deps
  )
  const paneKey = runtime.getTerminalPaneKey(handle)
  if (!paneKey) {
    throw new Error('Missing test pane key')
  }
  wiring.statusStore.ingestTerminalStatus({
    paneKey,
    payload: {
      state: 'working',
      agentType: 'antigravity',
      prompt: 'print marker',
      toolName: 'run_command'
    }
  })
  const approval = readFileSync(
    join(__dirname, '__fixtures__/antigravity-windows-command-approval.txt'),
    'utf8'
  )
  runtime.onPtyData(TRANSCRIPT_PANE_PTY_ID, approval, Date.now())
  await vi.waitFor(() =>
    expect(wiring.statusStore.getStatusSnapshot()[0]).toMatchObject({
      state: 'waiting',
      observation: { origin: 'process' }
    })
  )
  expect(wiring.statusStore.getStatusSnapshot()[0].interactivePrompt).toContain(
    'ORCA_PERMISSION_CAPTURE_OK'
  )
  const cancelled = readFileSync(join(__dirname, `__fixtures__/${capture}.txt`), 'utf8')
  runtime.onPtyData(TRANSCRIPT_PANE_PTY_ID, cancelled, Date.now())
  await vi.waitFor(
    () => expect(wiring.statusStore.getStatusSnapshot()[0]).toMatchObject({ state }),
    { timeout: 5000 }
  )
  expect(wiring.statusStore.getStatusSnapshot()[0].interactivePrompt).toBeUndefined()
})

it('recognizes the actual macOS 1.2.14 Claude command permission grid', async () => {
  const { ruledScreenLines } = await finalReplayFrame(
    'antigravity-macos-1-2-14-command-approval',
    159,
    69
  )
  expect(isAntigravityCommandApprovalScreen(ruledScreenLines)).toBe(true)
  expect(
    evaluateAgentStateRules('antigravity', { readScreenLines: () => ruledScreenLines })
  ).toMatchObject({ state: 'hold' })
})
