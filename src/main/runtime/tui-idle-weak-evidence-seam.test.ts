/**
 * The seam a new weak-ready rank plugs into. Weak ready is a verdict class, not a per-evidence
 * flag: no settle site may act on it before a rendered-screen read, whatever evidence produced
 * it. The stand-in below fires over Claude's trust dialog itself, as a composer-ready signal
 * such as bracketed paste would, and the dialog must still win.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTranscriptPane, TRANSCRIPT_PANE_PTY_ID } from './agent-transcript-pane-test-harness'
import type * as TuiIdleEvidence from './tui-idle-evidence'

const syntheticWeakEvidence = vi.hoisted(() => ({ fires: false }))

vi.mock('./tui-idle-evidence', async (importOriginal) => {
  const actual = await importOriginal<typeof TuiIdleEvidence>()
  return {
    ...actual,
    evaluateTuiIdle: (
      ...args: Parameters<typeof actual.evaluateTuiIdle>
    ): TuiIdleEvidence.TuiIdleVerdict => {
      const verdict = actual.evaluateTuiIdle(...args)
      return syntheticWeakEvidence.fires && verdict.kind === 'pending'
        ? { kind: 'ready-weak' }
        : verdict
    }
  }
})

const POLL_INTERVAL_MS = 2_000

function readDialog(): { data: string; size: { cols: number; rows: number } } {
  const base = join(__dirname, '__fixtures__', 'claude-dialog-trust-workspace')
  const meta: { cols: number; rows: number } = JSON.parse(readFileSync(`${base}.meta.json`, 'utf8'))
  return { data: readFileSync(`${base}.txt`, 'utf8'), size: { cols: meta.cols, rows: meta.rows } }
}

async function createPane() {
  const { data, size } = readDialog()
  const { runtime, handle } = await createTranscriptPane({
    paneTitle: 'Terminal',
    foregroundProcess: 'claude',
    launchAgent: 'claude',
    size,
    data: ''
  })
  vi.useFakeTimers()
  const write = (chunk: string) => runtime.onPtyData(TRANSCRIPT_PANE_PTY_ID, chunk, Date.now())
  const paintDialog = () => {
    const bytes = Buffer.from(data, 'utf8')
    const decoder = new TextDecoder()
    for (let offset = 0; offset < bytes.length; offset += 1024) {
      write(decoder.decode(bytes.subarray(offset, offset + 1024), { stream: true }))
    }
  }
  const wait = () => {
    const settled = vi.fn()
    const promise = runtime.waitForTerminal(handle, { condition: 'tui-idle', timeoutMs: 60_000 })
    promise.then(settled, () => {})
    return { promise, settled }
  }
  return { write, paintDialog, wait }
}

describe('a new weak-ready rank', () => {
  afterEach(() => {
    syntheticWeakEvidence.fires = false
    vi.useRealTimers()
  })

  it('settles a pane with nothing on screen, so the stand-in reaches the settle sites', async () => {
    const pane = await createPane()
    pane.write('starting\r\n')
    syntheticWeakEvidence.fires = true
    const { promise } = pane.wait()
    await vi.advanceTimersByTimeAsync(0)
    await expect(promise).resolves.toMatchObject({ satisfied: true })
  })

  it('reports the dialog to a wait registered after it painted', async () => {
    const pane = await createPane()
    pane.paintDialog()
    syntheticWeakEvidence.fires = true
    const { promise } = pane.wait()
    await vi.advanceTimersByTimeAsync(0)
    await expect(promise).resolves.toMatchObject({
      satisfied: false,
      blockedReason: 'agent-trust-workspace'
    })
  })

  it('reports the dialog when a title change offers the evidence before it painted', async () => {
    const pane = await createPane()
    const { promise, settled } = pane.wait()
    syntheticWeakEvidence.fires = true
    pane.write('\x1b]0;claude ~/p/repo\x07')
    await vi.advanceTimersByTimeAsync(0)
    expect(settled).not.toHaveBeenCalled()
    pane.paintDialog()
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
    await expect(promise).resolves.toMatchObject({
      satisfied: false,
      blockedReason: 'agent-trust-workspace'
    })
  })
})
