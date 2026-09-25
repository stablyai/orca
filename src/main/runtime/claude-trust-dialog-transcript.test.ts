/**
 * Claude Code's first-launch trust dialog, replayed byte for byte from captured transcripts
 * (`__fixtures__/claude-dialog-trust-workspace*.txt`).
 *
 * The dialog parks the cursor on its highlighted option with a cursor-up, and the host's line tail
 * drops every row below the cursor — "Yes, I trust this folder" and "Enter to confirm". The
 * tui-idle poll therefore reads the runtime's rendered screen, which still shows them.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createTranscriptPane, TRANSCRIPT_PANE_PTY_ID } from './agent-transcript-pane-test-harness'

function readCapture(name: string): { data: string; size: { cols: number; rows: number } } {
  const base = join(__dirname, '__fixtures__', name)
  const meta: { cols: number; rows: number } = JSON.parse(readFileSync(`${base}.meta.json`, 'utf8'))
  return { data: readFileSync(`${base}.txt`, 'utf8'), size: { cols: meta.cols, rows: meta.rows } }
}

async function waitOnReplay(name: string, readSize: number | null) {
  const { data, size } = readCapture(name)
  const { runtime, handle } = await createTranscriptPane({
    paneTitle: 'Claude Code',
    foregroundProcess: 'claude',
    launchAgent: 'claude',
    size,
    data: ''
  })
  const bytes = Buffer.from(data, 'utf8')
  const step = readSize ?? bytes.length
  // Why a streaming decoder: a PTY read can end inside a multi-byte character, as a real one does.
  const decoder = new TextDecoder()
  for (let offset = 0; offset < bytes.length; offset += step) {
    const read = decoder.decode(bytes.subarray(offset, offset + step), { stream: true })
    runtime.onPtyData(TRANSCRIPT_PANE_PTY_ID, read, Date.now())
  }
  return runtime.waitForTerminal(handle, { condition: 'tui-idle', timeoutMs: 5000 })
}

describe("Claude's workspace trust dialog, from captured transcripts", () => {
  it('reports the dialog as a blocking prompt instead of waiting out the whole budget', async () => {
    await expect(waitOnReplay('claude-dialog-trust-workspace', null)).resolves.toMatchObject({
      satisfied: false,
      blockedReason: 'agent-trust-workspace'
    })
  })

  it('still reports it when the dialog arrives in the 1024-byte reads a live Claude produced', async () => {
    // Why: the tail's plain path blanks each `text\r\r\n` line of a read that carries no
    // cursor-up, so the opening question never survives there; the screen is unaffected.
    await expect(waitOnReplay('claude-dialog-trust-workspace', 1024)).resolves.toMatchObject({
      satisfied: false,
      blockedReason: 'agent-trust-workspace'
    })
  })

  it('reports it on a narrow pane, where Claude wraps the question across lines', async () => {
    await expect(waitOnReplay('claude-dialog-trust-workspace-narrow', null)).resolves.toMatchObject(
      { satisfied: false, blockedReason: 'agent-trust-workspace' }
    )
  })

  it('reports the agent ready, not blocked, once the user has answered "Yes"', async () => {
    const wait = await waitOnReplay('claude-dialog-trust-workspace-answered', 1024)
    expect(wait).toMatchObject({ satisfied: true })
    expect(wait).not.toHaveProperty('blockedReason')
  })
})
