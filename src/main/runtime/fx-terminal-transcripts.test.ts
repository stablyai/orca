import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { extractLastOscTitle } from '../../shared/osc-title-extraction'
import { createTranscriptPane } from './agent-transcript-pane-test-harness'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp') }
}))

const ESC = String.fromCharCode(27)

function fixture(name: string): string {
  return readFileSync(join(__dirname, '__fixtures__', `${name}.txt`), 'utf8')
}

describe('fx terminal evidence', () => {
  it.each([
    ['fx-startup-ready', 'Run /help for commands'],
    ['fx-active-turn', 'Generating'],
    ['fx-permission-prompt', 'Permission needed · Review change'],
    ['fx-post-turn-ready', 'EVIDENCE_COMPLETE']
  ])('replays raw %s output through the runtime', async (name, evidence) => {
    const transcript = fixture(name)
    const { runtime, handle } = await createTranscriptPane({
      paneTitle: extractLastOscTitle(transcript) ?? 'fx',
      foregroundProcess: 'fx',
      data: transcript
    })

    expect(transcript).toContain(ESC)
    expect(transcript).toContain(evidence)
    await expect(runtime.getTerminalAgentStatus(handle)).resolves.toMatchObject({
      isRunningAgent: true
    })
  })

  it('does not infer completed status from fx returning to its composer', async () => {
    const transcript = fixture('fx-post-turn-ready')
    const { runtime, handle } = await createTranscriptPane({
      paneTitle: extractLastOscTitle(transcript) ?? 'fx',
      foregroundProcess: 'fx',
      data: transcript
    })

    await expect(runtime.getTerminalAgentStatus(handle)).resolves.toMatchObject({
      isRunningAgent: true,
      status: null
    })
  })
})
