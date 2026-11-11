import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentStatusIpcPayload } from '../../../../shared/agent-status/contracts/agent-status-ipc-payload'
import type { TuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent'
import { parseInteractivePrompt } from '../../../../shared/native-chat/input/native-chat-interactive-prompt'
import { z } from 'zod'
import { RpcDispatcher } from '../../rpc/dispatcher'
import { TERMINAL_METHODS } from '../../rpc/methods/terminal/terminal'
import {
  createTranscriptPane,
  TRANSCRIPT_PANE_PTY_ID
} from '../../orca-runtime-tests/agent-transcript-pane-test-harness'

function fixture(name: string): { recording: string; cols: number; rows: number } {
  const url = (ext: string) => new URL(`../../__fixtures__/${name}.${ext}`, import.meta.url)
  const meta: { cols: number; rows: number } = JSON.parse(readFileSync(url('meta.json'), 'utf8'))
  return { recording: readFileSync(url('txt'), 'utf8'), cols: meta.cols, rows: meta.rows }
}

const SEND_RESULT = z.object({ send: z.object({ accepted: z.boolean() }) })

async function createTrustDialogPane(
  name: string,
  launchAgent: TuiAgent = 'claude',
  overrides: Partial<Parameters<typeof createTranscriptPane>[0]> = {}
) {
  const { recording, cols, rows: gridRows } = fixture(name)
  const rows = new Map<string, AgentStatusIpcPayload>()
  const published: string[] = []
  const prompts: (string | undefined)[] = []
  let receivedAt = 0
  const { runtime, handle } = await createTranscriptPane(
    {
      paneTitle: 'Terminal',
      foregroundProcess: '2.1.310',
      launchAgent,
      size: { cols, rows: gridRows },
      data: '',
      ...overrides
    },
    {
      onTerminalAgentStatus: ({ paneKey, payload }) => {
        published.push(payload.state)
        prompts.push(payload.interactivePrompt)
        receivedAt += 1
        rows.set(paneKey, {
          ...payload,
          paneKey,
          connectionId: null,
          receivedAt,
          stateStartedAt: 1
        })
      },
      getAgentStatusSnapshotForPane: (paneKey) => {
        const current = rows.get(paneKey)
        return current ? [current] : []
      }
    }
  )
  let seq = 0
  /** Received output the screen model has not applied until timers run. */
  const receive = (data: string) => runtime.onPtyData(TRANSCRIPT_PANE_PTY_ID, data, ++seq)
  const write = async (data: string, chunkSize = data.length) => {
    for (let index = 0; index < data.length; index += chunkSize) {
      receive(data.slice(index, index + chunkSize))
    }
    await vi.advanceTimersByTimeAsync(100)
  }
  return { runtime, handle, rows, published, prompts, recording, cols, gridRows, receive, write }
}

describe('TrustDialogStatusObserver', () => {
  const cleanups: (() => Promise<void>)[] = []
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) {
      await cleanup()
    }
    vi.useRealTimers()
  })

  async function pane(
    name: string,
    launchAgent?: TuiAgent,
    overrides?: Partial<Parameters<typeof createTranscriptPane>[0]>
  ) {
    vi.useFakeTimers()
    const created = await createTrustDialogPane(name, launchAgent, overrides)
    cleanups.push(async () => {
      await created.runtime.onPtyExit(TRANSCRIPT_PANE_PTY_ID, 0)
    })
    return created
  }

  const UP = '\x1b[A'
  const DOWN = '\x1b[B'
  const MCP_SERVERS_DIALOG =
    '2 new MCP servers found in this project Select any you wish to enable.\n\n' +
    'MCP servers may execute code or access system resources. All tool calls require approval. Learn more in the MCP documentation.'
  // Keys verified against Claude Code 2.1.322: Enter on a server row toggles it, on the last row enables the ticked ones.
  it.each([
    [
      'claude-2-1-322-startup-mcp-servers',
      '[✔] scratch-echo\n[✔] scratch-time',
      `${DOWN}${DOWN}\r`
    ],
    [
      'claude-2-1-322-startup-mcp-servers-unchecked',
      '[ ] scratch-echo\n[✔] scratch-time',
      `${DOWN}${DOWN}\r`
    ],
    ['claude-2-1-322-startup-mcp-servers-on-submit', '[✔] scratch-echo\n[✔] scratch-time', '\r']
  ])('offers %s a card listing the servers it would enable', async (name, servers, enable) => {
    const { prompts, recording, write } = await pane(name)
    await write(recording, 1)
    await vi.advanceTimersByTimeAsync(2_000)
    const card = parseInteractivePrompt(prompts.at(-1), undefined, 'claude')
    expect(card?.kind === 'approval' && card.approval).toEqual({
      startupDialog: expect.any(String),
      neutralOptions: true,
      title: 'Claude is waiting for a choice in the terminal',
      description: `${MCP_SERVERS_DIALOG}\n\n${servers}`,
      options: [
        { label: 'Enable selected', send: enable },
        { label: 'Reject all', send: '\x1b' }
      ]
    })
  })

  // The keys are aimed from the highlight the card was read off, so a card that no longer matches the screen must not write.
  it('writes a startup card choice only while the screen still reads as that card', async () => {
    const writes: string[] = []
    const { runtime, handle, prompts, recording, receive, write } = await pane(
      'claude-2-1-316-startup-mcp-server',
      'claude',
      { onWrite: (data) => writes.push(data) }
    )
    const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })
    const choose = async (prompt: string | undefined, send: string) => {
      const response = await dispatcher.dispatch(
        {
          id: 'choice',
          authToken: 'test',
          method: 'terminal.send',
          params: { terminal: handle, text: send, enter: false, requireStartupDialog: prompt }
        },
        { caller: { kind: 'desktop' } }
      )
      return response.ok && SEND_RESULT.parse(response.result).send.accepted
    }
    await write(recording)
    const stale = prompts.at(-1)
    // Up in the terminal: "Use this MCP server" is now two rows up from the highlight, not one.
    await write(
      '\x1b[9;1H\x1b[2K  ❯ Use this and all future MCP servers in this project' +
        '\x1b[10;1H\x1b[2K    Continue without using this MCP server'
    )
    await expect(choose(stale, `${UP}${UP}\r`)).resolves.toBe(false)
    await vi.advanceTimersByTimeAsync(1_000)
    // Down arrived but is not on the screen model yet: the model cannot vouch for the card.
    receive(
      '\x1b[9;1H\x1b[2K    Use this and all future MCP servers in this project' +
        '\x1b[10;1H\x1b[2K  ❯ Continue without using this MCP server'
    )
    expect(runtime.isStartupDialogCardCurrent(TRANSCRIPT_PANE_PTY_ID, prompts.at(-1)!)).toBe(false)
    await vi.advanceTimersByTimeAsync(1_000)
    await expect(choose(prompts.at(-1), `${UP}${UP}\r`)).resolves.toBe(true)
    // Answered from the terminal: the next dialog must not take a stale card's keys.
    const answered = prompts.at(-1)
    await write('\x1b[2J\x1b[H')
    await expect(choose(answered, `${UP}${UP}\r`)).resolves.toBe(false)
    expect(writes).toEqual([`${UP}${UP}\r`])
  })
})
