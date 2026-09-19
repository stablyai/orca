import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createTranscriptPane, TRANSCRIPT_PANE_PTY_ID } from './agent-transcript-pane-test-harness'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp') }
}))

function capture(name: string): string {
  const raw = readFileSync(join(__dirname, '__fixtures__', `${name}.txt`), 'utf8')
  const teardown =
    name === 'antigravity-dialog-trust-workspace' ? raw.lastIndexOf('\x1b[?1049l') : -1
  // Replay the recorded live dialog before capture shutdown leaves its alternate screen.
  return teardown === -1 ? raw : raw.slice(0, teardown)
}

describe('Antigravity ordinary waits use the current screen', () => {
  it.concurrent.each([
    ['antigravity-ready-default-127', true],
    ['antigravity-ready-plan-127', true],
    ['antigravity-ready-accept-edits-127', true],
    ['antigravity-plan-hint-as-draft-127', false],
    ['antigravity-composer-multiline-unsent', false],
    ['antigravity-dialog-model-picker', false],
    ['antigravity-busy-mid-turn', false]
  ] as const)('%s ready=%s', async (name, ready) => {
    const { runtime, handle } = await createTranscriptPane({
      paneTitle: 'agy',
      foregroundProcess: 'agy',
      data: ''
    })
    runtime.seedHeadlessTerminal(TRANSCRIPT_PANE_PTY_ID, '\x1b[0m', { cols: 120, rows: 40 })
    runtime.onPtyData(TRANSCRIPT_PANE_PTY_ID, capture(name), Date.now())
    const waiting = runtime.waitForTerminal(handle, { condition: 'tui-idle', timeoutMs: 3500 })
    await (ready
      ? expect(waiting).resolves.toMatchObject({ satisfied: true })
      : expect(waiting).rejects.toThrow('timeout'))
  })

  it('forgets a trust dialog after the real ready-screen redraw', async () => {
    const { runtime, handle } = await createTranscriptPane({
      paneTitle: 'agy',
      foregroundProcess: 'agy',
      data: ''
    })
    runtime.seedHeadlessTerminal(TRANSCRIPT_PANE_PTY_ID, '\x1b[0m', { cols: 120, rows: 40 })
    runtime.onPtyData(
      TRANSCRIPT_PANE_PTY_ID,
      capture('antigravity-dialog-trust-workspace'),
      Date.now()
    )
    await expect(
      runtime.waitForTerminal(handle, { condition: 'tui-idle', timeoutMs: 3500 })
    ).resolves.toMatchObject({ satisfied: false, blockedReason: 'agent-trust-workspace' })
    runtime.onPtyData(TRANSCRIPT_PANE_PTY_ID, capture('antigravity-ready-default-127'), Date.now())
    await expect(
      runtime.waitForTerminal(handle, { condition: 'tui-idle', timeoutMs: 3500 })
    ).resolves.toMatchObject({ satisfied: true })
  }, 10000)

  it('invalidates a ready screen before draft output finishes parsing', async () => {
    const { runtime, handle } = await createTranscriptPane({
      paneTitle: 'agy',
      foregroundProcess: 'agy',
      data: ''
    })
    runtime.seedHeadlessTerminal(TRANSCRIPT_PANE_PTY_ID, '\x1b[0m', { cols: 120, rows: 40 })
    runtime.onPtyData(TRANSCRIPT_PANE_PTY_ID, capture('antigravity-ready-plan-127'), Date.now())
    await expect(
      runtime.waitForTerminal(handle, { condition: 'tui-idle', timeoutMs: 3500 })
    ).resolves.toMatchObject({ satisfied: true })
    runtime.onPtyData(
      TRANSCRIPT_PANE_PTY_ID,
      capture('antigravity-plan-hint-as-draft-127'),
      Date.now()
    )
    await expect(
      runtime.waitForTerminal(handle, { condition: 'tui-idle', timeoutMs: 2500 })
    ).rejects.toThrow('timeout')
  }, 10000)

  it('invalidates a ready screen when the terminal grid reflows', async () => {
    const { runtime, handle } = await createTranscriptPane({
      paneTitle: 'agy',
      foregroundProcess: 'agy',
      data: ''
    })
    runtime.seedHeadlessTerminal(TRANSCRIPT_PANE_PTY_ID, '\x1b[0m', { cols: 120, rows: 40 })
    runtime.onPtyData(TRANSCRIPT_PANE_PTY_ID, capture('antigravity-ready-plan-127'), Date.now())
    await expect(
      runtime.waitForTerminal(handle, { condition: 'tui-idle', timeoutMs: 3500 })
    ).resolves.toMatchObject({ satisfied: true })
    runtime.reflowHeadlessTerminalToPtyGrid(TRANSCRIPT_PANE_PTY_ID, 20, 40)
    await expect(
      runtime.waitForTerminal(handle, { condition: 'tui-idle', timeoutMs: 2500 })
    ).rejects.toThrow('timeout')
  }, 10000)

  it('rechecks queued delivery after a draft becomes an empty composer', async () => {
    const { runtime, handle } = await createTranscriptPane({
      paneTitle: 'agy',
      foregroundProcess: 'agy',
      data: ''
    })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these protected methods are exercised by the real delivery path; only the final delivery action is spied on.
    const delivery = runtime as unknown as {
      checkDeliverySettledAndArmRecheck(leaf: { tabId: string; leafId: string }): boolean
      deliverPendingMessagesForLeaf(leaf: unknown): void
    }
    const deliver = vi.spyOn(delivery, 'deliverPendingMessagesForLeaf').mockImplementation(() => {})
    const leaf = { tabId: 'tab-1', leafId: '11111111-1111-4111-8111-111111111111' }
    runtime.seedHeadlessTerminal(TRANSCRIPT_PANE_PTY_ID, '\x1b[0m', { cols: 120, rows: 40 })
    runtime.onPtyData(
      TRANSCRIPT_PANE_PTY_ID,
      capture('antigravity-plan-hint-as-draft-127'),
      Date.now()
    )
    expect(delivery.checkDeliverySettledAndArmRecheck(leaf)).toBe(false)
    await expect(
      runtime.waitForTerminal(handle, { condition: 'tui-idle', timeoutMs: 3500 })
    ).rejects.toThrow('timeout')
    expect(deliver).not.toHaveBeenCalled()
    runtime.onPtyData(TRANSCRIPT_PANE_PTY_ID, capture('antigravity-ready-plan-127'), Date.now())
    await vi.waitFor(() => expect(deliver).toHaveBeenCalled(), { timeout: 4500 })
  }, 10000)

  it('does not reuse a ready screen after the execution host becomes unverifiable', async () => {
    const { runtime, handle } = await createTranscriptPane({
      paneTitle: 'agy',
      foregroundProcess: 'agy',
      data: '',
      connectionId: 'ssh-host'
    })
    runtime.seedHeadlessTerminal(TRANSCRIPT_PANE_PTY_ID, '\x1b[0m', { cols: 120, rows: 40 })
    runtime.onPtyData(TRANSCRIPT_PANE_PTY_ID, capture('antigravity-ready-default-127'), Date.now())
    await expect(
      runtime.waitForTerminal(handle, { condition: 'tui-idle', timeoutMs: 3500 })
    ).resolves.toMatchObject({ satisfied: true })
    runtime.markPtyLivenessUnverifiable(TRANSCRIPT_PANE_PTY_ID, 'SSH transport disconnected')
    await expect(
      runtime.waitForTerminal(handle, { condition: 'tui-idle', timeoutMs: 2500 })
    ).rejects.toThrow('timeout')
    expect(runtime.getPtyLivenessVerdict(TRANSCRIPT_PANE_PTY_ID)?.status).toBe('unverifiable')
  }, 10000)
})
