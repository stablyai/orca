import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentStatusIpcPayload } from '../../shared/agent-status-types'
import { parseInteractivePrompt } from '../../shared/native-chat-interactive-prompt'
import type { TuiAgent } from '../../shared/tui-agent'
import { createTranscriptPane, TRANSCRIPT_PANE_PTY_ID } from './agent-transcript-pane-test-harness'

function fixture(name: string): { recording: string; cols: number; rows: number } {
  const url = (ext: string) => new URL(`./__fixtures__/${name}.${ext}`, import.meta.url)
  const meta: { cols: number; rows: number } = JSON.parse(readFileSync(url('meta.json'), 'utf8'))
  return { recording: readFileSync(url('txt'), 'utf8'), cols: meta.cols, rows: meta.rows }
}

const CODEX_COMPOSER = '\x1b[2J\x1b[H\u203a Ask Codex to do anything\r\n  gpt-5 \u00b7 ~/repo\r\n'
const SHELL_PROMPT = '\x1b[J\r\nuser@host repo $ '

async function createTrustDialogPane(name: string, launchAgent: TuiAgent = 'claude') {
  const { recording, cols, rows: gridRows } = fixture(name)
  const rows = new Map<string, AgentStatusIpcPayload>()
  const published: string[] = []
  const prompts: (string | undefined)[] = []
  let receivedAt = 0
  const { runtime } = await createTranscriptPane(
    {
      paneTitle: 'Terminal',
      foregroundProcess: '2.1.310',
      launchAgent,
      size: { cols, rows: gridRows },
      data: ''
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
  const write = async (data: string, chunkSize = data.length) => {
    for (let index = 0; index < data.length; index += chunkSize) {
      runtime.onPtyData(TRANSCRIPT_PANE_PTY_ID, data.slice(index, index + chunkSize), ++seq)
    }
    await vi.advanceTimersByTimeAsync(100)
  }
  return { runtime, rows, published, prompts, recording, cols, gridRows, write }
}

describe('TrustDialogStatusObserver', () => {
  const cleanups: (() => Promise<void>)[] = []
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) {
      await cleanup()
    }
    vi.useRealTimers()
  })

  async function pane(name: string, launchAgent?: TuiAgent) {
    vi.useFakeTimers()
    const created = await createTrustDialogPane(name, launchAgent)
    cleanups.push(async () => {
      await created.runtime.onPtyExit(TRANSCRIPT_PANE_PTY_ID, 0)
    })
    return created
  }

  // One byte at a time splits the keyword; Claude's Ink paints words apart with cursor moves.
  it.each([
    ['claude-dialog-trust-workspace', 'claude', 1, ['waiting']],
    ['claude-dialog-trust-workspace-narrow', 'claude', 1, ['waiting']],
    ['claude-dialog-trust-workspace-answered', 'claude', 64, ['waiting', 'done']],
    ['codex-0-158-0-trustprompt', 'codex', 1, ['waiting']]
  ] as const)('replays %s (%s) in %i-byte chunks', async (name, agent, size, expected) => {
    const { published, recording, write } = await pane(name, agent)
    await write(recording, size)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(published).toEqual(expected)
  })

  // Keys verified against Claude Code 2.1.316: digits do nothing, Down+Enter trusts, Enter alone exits.
  it.each([
    ['claude-dialog-trust-workspace', 'claude', '\x1b[B\r'],
    ['claude-dialog-trust-workspace-narrow', 'claude', '\x1b[B\r'],
    ['codex-0-158-0-trustprompt', 'codex', '\r']
  ] as const)(
    'offers %s (%s) a trust card that picks the trust choice',
    async (name, agent, keys) => {
      const { prompts, recording, write } = await pane(name, agent)
      await write(recording, 1)
      const card = parseInteractivePrompt(prompts[0], undefined, agent)
      expect(card?.kind === 'approval' && card.approval.options).toEqual([
        { label: 'Trust folder', send: keys },
        { label: 'Exit', send: '\x1b' }
      ])
    }
  )

  it('re-aims the trust card when the cursor moves in the terminal', async () => {
    const { prompts, recording, write } = await pane('codex-0-158-0-trustprompt', 'codex')
    await write(recording)
    // Down in the terminal: Codex repaints its choices with the cursor on "2. Quit".
    await write('\x1b[9;1H\x1b[2K  1. Trust and continue\x1b[10;1H\x1b[2K› 2. Quit')
    await vi.advanceTimersByTimeAsync(1_000)
    const card = parseInteractivePrompt(prompts.at(-1), undefined, 'codex')
    expect(card?.kind === 'approval' && card.approval.options[0]?.send).toBe('\x1b[A\r')
  })

  // A send would still hit the highlighted choice, so the card keeps Exit and locks terminal sends.
  it('offers only Exit when no highlighted choice is visible', async () => {
    const { prompts, recording, write } = await pane('codex-0-158-0-trustprompt', 'codex')
    await write(recording.replaceAll('\u203a 1. Trust', '  1. Trust'))
    const card = parseInteractivePrompt(prompts[0], undefined, 'codex')
    expect(card?.kind === 'approval' && card.approval.options).toEqual([
      { label: 'Exit', send: '\x1b' }
    ])
  })

  const UP = '\x1b[A'
  const DOWN = '\x1b[B'
  // Keys verified against Claude Code 2.1.316 with a scratch config: arrows move the highlight, Enter picks it.
  it.each([
    [
      'claude-2-1-316-startup-mcp-server',
      'New MCP server found in this project: scratch-echo',
      [
        ['Use this MCP server', `${UP}${UP}\r`],
        ['Use this and all future MCP servers in this project', `${UP}\r`],
        ['Continue without using this MCP server', '\r']
      ]
    ],
    [
      'claude-2-1-316-startup-mcp-server-narrow',
      'New MCP server found in this project: scratch-echo',
      [
        ['Use this MCP server', `${UP}${UP}\r`],
        ['Use this and all future MCP servers in this project', `${UP}\r`],
        ['Continue without using this MCP server', '\r']
      ]
    ],
    [
      'claude-2-1-316-startup-api-key',
      'Detected a custom API key in your environment',
      [
        ['Yes', `${UP}\r`],
        ['No (recommended)', '\r']
      ]
    ],
    [
      'claude-2-1-316-startup-bypass-permissions',
      'WARNING: Claude Code running in Bypass Permissions mode',
      [
        ['No, exit', '\r'],
        ['Yes, I accept', `${DOWN}\r`]
      ]
    ],
    [
      'claude-2-1-316-startup-external-imports',
      'Allow external CLAUDE.md file imports?',
      [
        ['No, disable external imports', '\r'],
        ['Yes, allow external imports', `${DOWN}\r`]
      ]
    ]
  ])('offers %s a card with its own choices', async (name, description, choices) => {
    const { published, prompts, recording, write } = await pane(name)
    await write(recording, 1)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(published).toEqual(['waiting'])
    const card = parseInteractivePrompt(prompts[0], undefined, 'claude')
    expect(card?.kind === 'approval' && card.approval).toEqual({
      title: 'Claude is waiting for a choice in the terminal',
      description,
      options: choices.map(([label, send]) => ({ label, send }))
    })
  })

  // Codex's startup menu keys are not verified, so its card only locks Send and points at the terminal.
  it.each(['codex-0158-update-available-dialog', 'codex-0158-hooks-review-dialog'])(
    'offers %s a card without answers',
    async (name) => {
      const { published, prompts, recording, write } = await pane(name, 'codex')
      await write(recording, 1)
      expect(published).toEqual(['waiting'])
      const card = parseInteractivePrompt(prompts[0], undefined, 'codex')
      expect(card?.kind === 'approval' && card.approval).toEqual({
        title: 'Codex is waiting for a choice in the terminal',
        options: []
      })
    }
  )

  it('leaves a ready Claude composer alone', async () => {
    const { published, recording, write } = await pane('claude-2-1-316-default-labelled-blurred')
    await write(recording, 1)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(published).toEqual([])
  })

  it('re-aims the startup card when the highlight moves in the terminal', async () => {
    const { prompts, recording, write } = await pane('claude-2-1-316-startup-mcp-server')
    await write(recording)
    // Up in the terminal: Claude repaints its choices with the cursor on the middle row.
    await write(
      '\x1b[9;1H\x1b[2K  ❯ Use this and all future MCP servers in this project' +
        '\x1b[10;1H\x1b[2K    Continue without using this MCP server'
    )
    await vi.advanceTimersByTimeAsync(1_000)
    const card = parseInteractivePrompt(prompts.at(-1), undefined, 'claude')
    expect(card?.kind === 'approval' && card.approval.options.map((option) => option.send)).toEqual(
      [`${UP}\r`, '\r', `${DOWN}\r`]
    )
  })

  it('ignores the dialog wording quoted in ordinary output', async () => {
    const { published, write } = await pane('codex-0-158-0-trustprompt', 'codex')
    const reply = [
      '\u2022 Codex shows "Do you trust this folder?" with 1. Trust and continue',
      '  and Claude shows "Yes, I trust this folder".',
      '',
      '\u203a Ask Codex to do anything',
      '  gpt-5 \u00b7 ~/repo'
    ]
    await write(`${reply.join('\r\n')}\r\n`)
    expect(published).toEqual([])
  })

  it('keeps one waiting row through a resize repaint, then clears once the dialog is gone', async () => {
    const { published, recording, write } = await pane('claude-dialog-trust-workspace')
    await write(recording)
    expect(published).toEqual(['waiting'])
    // A resize repaint split across reads: one debounced read lands on the cleared screen.
    await write('\x1b[2J\x1b[H')
    await vi.advanceTimersByTimeAsync(400)
    await write(recording)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(published).toEqual(['waiting'])
    await write(SHELL_PROMPT)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(published).toEqual(['waiting', 'done'])
  })

  it('clears after a renderer-snapshot recovery replaces the screen model', async () => {
    const { runtime, published, recording, cols, gridRows, write } = await pane(
      'codex-0-158-0-trustprompt',
      'codex'
    )
    await write(recording)
    expect(published).toEqual(['waiting'])
    runtime.replaceHeadlessTerminalFromRendererSnapshotForRecovery(TRANSCRIPT_PANE_PTY_ID, {
      data: recording,
      cols,
      rows: gridRows
    })
    await write(CODEX_COMPOSER)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(published).toEqual(['waiting', 'done'])
  })

  it('leaves a hook row that replaced its own untouched', async () => {
    const { rows, published, recording, write } = await pane('claude-dialog-trust-workspace')
    await write(recording)
    const [paneKey, waiting] = [...rows][0]
    const hookRow: AgentStatusIpcPayload = {
      ...waiting,
      state: 'working',
      receivedAt: 99,
      observation: {
        origin: 'hook',
        authorityId: 'hooks',
        incarnation: 0,
        revision: 1,
        observedAt: 1
      }
    }
    rows.set(paneKey, hookRow)
    await write(SHELL_PROMPT)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(published).toEqual(['waiting'])
    expect(rows.get(paneKey)).toBe(hookRow)
  })

  it("clears a killed agent's leftover frame only once the shell is proven foreground", async () => {
    const { runtime, published, recording, write } = await pane('claude-dialog-trust-workspace')
    const foreground = vi.spyOn(runtime, 'readLaunchedAgentForeground').mockResolvedValue('unknown')
    await write(recording)
    // The shell prompt lands inside the stale frame, so the screen still shows the dialog.
    await write('user@host repo $ ')
    await vi.advanceTimersByTimeAsync(2_000)
    expect(published).toEqual(['waiting'])
    foreground.mockResolvedValue('shell')
    await write(' ')
    await vi.advanceTimersByTimeAsync(1_000)
    expect(published).toEqual(['waiting', 'done'])
  })
})
