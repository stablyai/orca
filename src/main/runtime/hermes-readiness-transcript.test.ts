import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createTranscriptPane, TRANSCRIPT_PANE_PTY_ID } from './agent-transcript-pane-test-harness'
import { createHookListenerState } from '../../shared/agent-hook-listener/listener-state'
import { normalizeHermesEvent } from '../../shared/agent-hook-listener/providers/hermes-events'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp') }
}))

const captured = readFileSync(join(__dirname, '__fixtures__', 'hermes-tui-ready.txt'), 'utf8')

/** The real payload Orca's managed Hermes plugin produces for `eventName`, wired through the
 *  same normalizer the hook relay uses — so a regression in the event mapping fails here too,
 *  not only in the provider's own unit test. */
const status = (eventName: string, payload: Record<string, unknown> = {}): string => {
  const parsed = normalizeHermesEvent(createHookListenerState(), eventName, '', 'pane-1', payload)
  expect(parsed, `hermes plugin event ${eventName} must normalize to a status`).not.toBeNull()
  return `\x1b]9999;${JSON.stringify(parsed)}\x07`
}

const readyPane = async () =>
  createTranscriptPane({
    paneTitle: 'Hermes Agent',
    foregroundProcess: 'hermes',
    launchAgent: 'hermes',
    size: { cols: 120, rows: 31 },
    data: captured
  })

describe('Hermes TUI readiness from a captured PTY', () => {
  it('settles tui-idle on the session-boundary row a freshly launched Hermes emits', async () => {
    const { runtime, handle } = await readyPane()
    // What Orca's own managed plugin sends for `on_session_start`.
    runtime.onPtyData(
      TRANSCRIPT_PANE_PTY_ID,
      status('on_session_start', { session_id: 's1' }),
      Date.now()
    )

    const read = vi.spyOn(runtime, 'readTerminal')
    await expect(
      runtime.waitForTerminal(handle, { condition: 'tui-idle', timeoutMs: 2_000 })
    ).resolves.toMatchObject({ satisfied: true })
    // The boundary row is tier-1 evidence, so no pane's screen is serialized to settle it.
    expect(read.mock.calls.filter(([, options]) => options?.screen === true)).toEqual([])
  }, 5_000)

  it('settles through a leaf handle whose retained tail never showed the ready screen', async () => {
    const { runtime } = await readyPane()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Access the real synced leaf and handle issuer for this route regression.
    const internals = runtime as unknown as {
      leaves: Map<string, { tailBuffer: string[]; tailPartialLine: string }>
      issueHandle: (leaf: unknown) => string
    }
    const leaf = internals.leaves.values().next().value
    expect(leaf).toBeDefined()
    expect([...leaf!.tailBuffer, leaf!.tailPartialLine].join('\n')).not.toMatch(/\bready\b/i)
    runtime.onPtyData(
      TRANSCRIPT_PANE_PTY_ID,
      status('on_session_start', { session_id: 's1' }),
      Date.now()
    )

    await expect(
      runtime.waitForTerminal(internals.issueHandle(leaf), {
        condition: 'tui-idle',
        timeoutMs: 2_000
      })
    ).resolves.toMatchObject({ satisfied: true })
  }, 5_000)

  it('does not settle while a turn the user started is still running', async () => {
    const { runtime, handle } = await readyPane()
    runtime.onPtyData(
      TRANSCRIPT_PANE_PTY_ID,
      status('on_session_start', { session_id: 's1' }),
      Date.now()
    )
    // `pre_llm_call` — the first event that means a turn actually began.
    runtime.onPtyData(
      TRANSCRIPT_PANE_PTY_ID,
      status('pre_llm_call', { user_message: 'hi' }),
      Date.now()
    )

    await expect(
      runtime.waitForTerminal(handle, { condition: 'tui-idle', timeoutMs: 550 })
    ).rejects.toThrow('timeout')
  }, 3_000)

  it('does not settle on a turn-end done row, only on a session boundary', async () => {
    const { runtime, handle } = await readyPane()
    // `post_llm_call` lands `done` without the boundary flag; the #6011 rule still applies.
    runtime.onPtyData(
      TRANSCRIPT_PANE_PTY_ID,
      status('post_llm_call', { session_id: 's1' }),
      Date.now()
    )

    await expect(
      runtime.waitForTerminal(handle, { condition: 'tui-idle', timeoutMs: 550 })
    ).rejects.toThrow('timeout')
  }, 3_000)

  it('reports a visible blocker instead of readiness when Hermes asks for approval', async () => {
    const { runtime, handle } = await readyPane()
    runtime.onPtyData(
      TRANSCRIPT_PANE_PTY_ID,
      status('on_session_start', { session_id: 's1' }),
      Date.now()
    )
    // `pre_approval_request` supersedes the boundary row the session opened with.
    runtime.onPtyData(
      TRANSCRIPT_PANE_PTY_ID,
      status('pre_approval_request', { command: 'rm -rf build' }),
      Date.now()
    )

    await expect(
      runtime.waitForTerminal(handle, { condition: 'tui-idle', timeoutMs: 550 })
    ).rejects.toThrow('timeout')
  }, 3_000)
})
