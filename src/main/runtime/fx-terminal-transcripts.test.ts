import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { extractLastOscTitle } from '../../shared/osc-title-extraction'
import { createTranscriptPane } from './agent-transcript-pane-test-harness'
import { assertTerminalAgentSendable } from './rpc/terminal-agent-send-guard'

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

  it('blocks guarded prompt sends while the approval dialog owns the live tail', async () => {
    const approval = fixture('fx-permission-prompt')
    const { runtime, handle } = await createTranscriptPane({
      paneTitle: extractLastOscTitle(approval) ?? 'fx',
      foregroundProcess: 'fx',
      data: approval
    })

    await expect(runtime.getTerminalInteractiveWait(handle)).resolves.toMatchObject({
      source: 'prompt-text',
      reason: 'agent-approval-prompt'
    })
    await expect(runtime.getTerminalAgentStatus(handle)).resolves.toMatchObject({
      isRunningAgent: true,
      status: 'permission'
    })
    await expect(
      assertTerminalAgentSendable({ runtime, handle, assertWritable: () => {} })
    ).rejects.toThrow('terminal_guard_permission')
    await expect(runtime.sendTerminalAgentPrompt(handle, 'continue')).rejects.toThrow(
      'agent_prompt_blocked'
    )
  })

  it.each(['fx-startup-ready', 'fx-active-turn', 'fx-post-turn-ready'])(
    'does not report an approval prompt for %s',
    async (name) => {
      const transcript = fixture(name)
      const { runtime, handle } = await createTranscriptPane({
        paneTitle: extractLastOscTitle(transcript) ?? 'fx',
        foregroundProcess: 'fx',
        data: transcript
      })

      await expect(runtime.getTerminalInteractiveWait(handle)).resolves.toBeNull()
    }
  )

  it('does not revive an approval dialog from scrollback or later narration', async () => {
    const approval = fixture('fx-permission-prompt')
    const ready = fixture('fx-post-turn-ready')
    const transcript = `${approval}\n${ready}\nThe earlier menu said Apply once and Enter Confirm.\n`
    const { runtime, handle } = await createTranscriptPane({
      paneTitle: extractLastOscTitle(ready) ?? 'fx',
      foregroundProcess: 'fx',
      data: transcript
    })

    await expect(runtime.getTerminalInteractiveWait(handle)).resolves.toBeNull()
  })

  it.each(['fx-active-turn', 'fx-post-turn-ready'])(
    'keeps ordinary status unknown for %s without a reliable transition signal',
    async (name) => {
      const transcript = fixture(name)
      const { runtime, handle } = await createTranscriptPane({
        paneTitle: extractLastOscTitle(transcript) ?? 'fx',
        foregroundProcess: 'fx',
        data: transcript
      })

      await expect(runtime.getTerminalAgentStatus(handle)).resolves.toMatchObject({
        isRunningAgent: true,
        status: null
      })
    }
  )
})
