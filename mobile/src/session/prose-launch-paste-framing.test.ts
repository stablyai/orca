import { describe, expect, it } from 'vitest'
import { buildDiffNotesAgentLaunchPrompt } from './diff-notes-agent-launch-prompt'
import { createTerminalAndSendPrompt } from './pr-ai-triage-launch'
import { buildMobileQuickCommandLaunch } from '../terminal/quick-commands'
import type { RpcClient } from '../transport/rpc-client'

const PASTE_START = '\u001b[200~'
const PASTE_END = '\u001b[201~'

const MULTILINE_NOTES = 'Address these notes.\n\nsrc/a.ts:1 fix this\n\nsrc/b.ts:2 and this'

type Sent = { method: string; text?: string; enter?: boolean }

function launchClient(sent: Sent[]): Pick<RpcClient, 'sendRequest'> {
  return {
    sendRequest: async (method: string, params: unknown) => {
      const sendParams = params as { text?: string; enter?: boolean }
      sent.push({ method, text: sendParams.text, enter: sendParams.enter })
      if (method === 'session.tabs.createTerminal') {
        return { ok: true, result: { tab: { type: 'terminal', id: 'tab-1', terminal: 'term-1' } } }
      }
      return { ok: true, result: { send: { accepted: true } } }
    }
  }
}

describe('diff notes launched into a new agent session', () => {
  it('frames the notes so the agent receives them as one prompt', () => {
    const launched = buildDiffNotesAgentLaunchPrompt(MULTILINE_NOTES)

    expect(launched.startsWith(PASTE_START)).toBe(true)
    expect(launched.endsWith(PASTE_END)).toBe(true)
    expect(launched).not.toContain('\n')
  })

  it('leaves a single-line note untouched', () => {
    expect(buildDiffNotesAgentLaunchPrompt('one note')).toBe('one note')
  })
})

describe('prompt sent into a freshly created agent terminal', () => {
  it('frames a multi-line prompt', async () => {
    const sent: Sent[] = []

    await createTerminalAndSendPrompt(launchClient(sent) as RpcClient, 'wt-1', MULTILINE_NOTES)

    const send = sent.find((entry) => entry.method === 'terminal.send')
    expect(send?.text?.startsWith(PASTE_START)).toBe(true)
    expect(send?.text).not.toContain('\n')
    expect(send?.enter).toBe(true)
  })

  it('leaves a single-line prompt untouched', async () => {
    const sent: Sent[] = []

    await createTerminalAndSendPrompt(launchClient(sent) as RpcClient, 'wt-1', 'do the thing')

    expect(sent.find((entry) => entry.method === 'terminal.send')?.text).toBe('do the thing')
  })
})

describe('the launch seam is overloaded, so shell commands stay unframed', () => {
  it('keeps a multi-line insert-only quick command byte-identical', () => {
    // Same initialPrompt seam as the diff-notes launch above. Framing here would
    // corrupt the command, which is why the opt-in lives at the prose caller.
    const launch = buildMobileQuickCommandLaunch({
      label: 'two liner',
      command: 'echo one\necho two',
      appendEnter: false
    } as never)

    expect(launch?.options.initialPrompt).toBe('echo one\necho two')
    expect(launch?.options.initialPrompt).not.toContain(PASTE_START)
    expect(launch?.options.enter).toBe(false)
  })
})
