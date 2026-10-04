import { afterEach, expect, it, vi } from 'vitest'
import { createTranscriptPane, TRANSCRIPT_PANE_PTY_ID } from './agent-transcript-pane-test-harness'
import { finalReplayFrame, readRuntimeFixture } from './agent-transcript-replay-test-harness'
import { makeAgentStatusStoreWiring } from './agent-status-store-wiring.test-fixture'
import type { OrcaRuntimeService } from './orca-runtime'
import { TUI_IDLE_QUIESCENCE_MS } from './orca-runtime-postlude'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: () => process.env.TMPDIR }
}))

const runtimes: OrcaRuntimeService[] = []
afterEach(() => {
  for (const runtime of runtimes.splice(0)) {
    runtime.onPtyExit(TRANSCRIPT_PANE_PTY_ID, 0)
  }
  vi.useRealTimers()
})

function productionScreenReader(runtime: OrcaRuntimeService) {
  const source: unknown = runtime
  if (!source || typeof source !== 'object' || !('antigravityScreenPermissions' in source)) {
    throw new Error('Production Antigravity screen publisher missing')
  }
  const publisher = source.antigravityScreenPermissions
  const deps: unknown =
    publisher && typeof publisher === 'object' && 'deps' in publisher ? publisher.deps : null
  if (
    !deps ||
    typeof deps !== 'object' ||
    !('readScreen' in deps) ||
    typeof deps.readScreen !== 'function'
  ) {
    throw new Error('Production Antigravity screen reader missing')
  }
  const readScreen = deps.readScreen
  return () => readScreen(TRANSCRIPT_PANE_PTY_ID)
}

async function pane(capture: string, cols = 120, rows = 40) {
  const size = { cols, rows }
  const result = await createTranscriptPane({
    paneTitle: 'agy',
    foregroundProcess: 'agy',
    data: readRuntimeFixture(capture),
    size
  })
  runtimes.push(result.runtime)
  return { ...result, size, read: productionScreenReader(result.runtime) }
}

it.each([
  ['antigravity-windows-command-approval', 120, 40],
  ['antigravity-macos-1-2-14-command-approval', 159, 69],
  ['antigravity-1-2-14-ready', 120, 40]
] as const)(
  'reads captured %s through the real runtime publication closure',
  async (capture, cols, rows) => {
    const { runtime, read } = await pane(capture, cols, rows)
    const expected = await finalReplayFrame(capture, cols, rows)
    await expect(read()).resolves.toMatchObject({
      lines: expected.ruledScreenLines,
      sequence: runtime.getPtyOutputSequence(TRANSCRIPT_PANE_PTY_ID)
    })
  }
)

it('refuses a captured approval painted for a different PTY grid', async () => {
  const { read, size } = await pane('antigravity-windows-command-approval')
  await read()
  size.cols = 100
  size.rows = 30
  await expect(read()).resolves.toBeNull()
})

it('refuses the captured grid after reflow without a TUI repaint', async () => {
  const { runtime, read, size } = await pane('antigravity-windows-command-approval')
  await read()
  size.cols = 100
  size.rows = 30
  runtime.reflowHeadlessTerminalToPtyGrid(TRANSCRIPT_PANE_PTY_ID, size.cols, size.rows)
  await expect(read()).resolves.toBeNull()
})

it('returns null when the PTY has no screen model', async () => {
  const { runtime } = await createTranscriptPane({
    paneTitle: 'agy',
    foregroundProcess: 'agy',
    data: ''
  })
  runtimes.push(runtime)
  await expect(productionScreenReader(runtime)()).resolves.toBeNull()
})

it('publishes captured permission and quiet ready state into the canonical host store', async () => {
  const wiring = makeAgentStatusStoreWiring()
  const { runtime, handle } = await createTranscriptPane(
    {
      paneTitle: 'agy',
      foregroundProcess: 'agy',
      data: '',
      size: { cols: 120, rows: 40 }
    },
    wiring.deps
  )
  runtimes.push(runtime)
  const paneKey = runtime.getTerminalPaneKey(handle)
  if (!paneKey) {
    throw new Error('Runtime pane binding missing')
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
  runtime.onPtyData(
    TRANSCRIPT_PANE_PTY_ID,
    readRuntimeFixture('antigravity-windows-command-approval'),
    Date.now()
  )
  await expect(productionScreenReader(runtime)()).resolves.not.toBeNull()
  await vi.waitFor(() =>
    expect(wiring.statusStore.getStatusSnapshot()[0]).toMatchObject({
      state: 'waiting',
      observation: { origin: 'process' }
    })
  )
  expect(wiring.statusStore.getStatusSnapshot()[0].interactivePrompt).toContain(
    'ORCA_PERMISSION_CAPTURE_OK'
  )
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
  runtime.onPtyData(
    TRANSCRIPT_PANE_PTY_ID,
    readRuntimeFixture('antigravity-1-2-14-ready'),
    Date.now()
  )
  await productionScreenReader(runtime)()
  await vi.advanceTimersByTimeAsync(TUI_IDLE_QUIESCENCE_MS - 1)
  expect(wiring.statusStore.getStatusSnapshot()[0].state).toBe('waiting')
  await vi.advanceTimersByTimeAsync(1)
  expect(wiring.statusStore.getStatusSnapshot()[0]).toMatchObject({ state: 'done' })
  expect(wiring.statusStore.getStatusSnapshot()[0].interactivePrompt).toBeUndefined()
})
