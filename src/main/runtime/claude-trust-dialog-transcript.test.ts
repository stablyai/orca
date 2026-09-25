/**
 * Claude Code's first-launch trust dialog, replayed byte for byte from a captured transcript
 * (`__fixtures__/claude-dialog-trust-workspace.txt`, recorded with
 * `config/scripts/capture-agent-pty-transcript.mjs`).
 *
 * The dialog parks the cursor on its highlighted option with a cursor-up, and the host's line tail
 * drops the lines below it — the two that say "trust this folder" and "Enter to confirm". What the
 * tail keeps is the opening question, so that wording is what has to be recognised.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createTranscriptPane } from './agent-transcript-pane-test-harness'

const TRANSCRIPT = readFileSync(
  join(__dirname, '__fixtures__', 'claude-dialog-trust-workspace.txt'),
  'utf8'
)

describe("Claude's workspace trust dialog, from a captured transcript", () => {
  it('reports the dialog as a blocking prompt instead of waiting out the whole budget', async () => {
    const { runtime, handle } = await createTranscriptPane({
      paneTitle: 'Claude Code',
      foregroundProcess: 'claude',
      launchAgent: 'claude',
      data: TRANSCRIPT
    })

    const wait = await runtime.waitForTerminal(handle, { condition: 'tui-idle', timeoutMs: 3000 })

    expect(wait).toMatchObject({ satisfied: false, blockedReason: 'agent-trust-workspace' })
  })
})
