import type * as TranscriptReadModule from '../orchestration/workers/transcripts/worker-transcript-read'
import { expect, it, vi } from 'vitest'
import type { RpcContext } from '../rpc/core'
import { readAgentConversation } from './agent-conversation-read'
import type { ResolvedAgentConversation } from './agent-conversation-address'

const terminal = vi.hoisted(() => ({
  source: vi.fn(),
  read: vi.fn()
}))
vi.mock('../../agent-hooks/server/agent-hook-server', () => ({
  agentHookServer: {
    terminalAgentTranscriptSource: terminal.source,
    terminalAgentPlaces: async () => []
  }
}))
vi.mock('../orchestration/workers/transcripts/worker-transcript-read', () => ({
  canReadWorkerTranscript: () => true,
  readWorkerTranscript: terminal.read
}))

vi.mock('../rpc/methods/structured-sessions/creation/structured-agent-session-gate', () => ({
  requireStructuredAgentAudience: () => {},
  requireInstalledStructuredHost: vi.fn()
}))

const actualTranscriptReader = await vi.importActual<typeof TranscriptReadModule>(
  '../orchestration/workers/transcripts/worker-transcript-read'
)

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the terminal read passes the context only to the mocked hook server.
const ctx = { runtime: { readLocalSleepingAgentSessions: () => ({}) } } as unknown as RpcContext

it.each([
  [
    'saved with no distro',
    '',
    "Orca can't read Claude agent claude_dd9b33e3's transcript because its saved location doesn't identify which WSL distro holds it. Run `orca agent show claude_dd9b33e3` to find any open terminal for this agent and view it there."
  ],
  ['saved with its distro', 'Ubuntu', null]
])(
  'reads a WSL terminal agent %s only when a distro was attested',
  async (_, wslDistro, refusal) => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { value: 'win32' })
    try {
      terminal.source.mockResolvedValue({
        key: {
          executionHost: 'local',
          wslDistro,
          agent: 'claude',
          providerSessionId: 'p',
          locator: ''
        },
        providerSession: {
          id: 'p',
          transcriptPath: '/home/qa/.claude-custom/projects/repo/p.jsonl'
        }
      })
      terminal.read.mockResolvedValue({ ok: false, reason: 'transcript_missing', warnings: [] })
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the terminal read uses only the id and the mocked hook server and reader.
      const agent = {
        kind: 'terminal',
        orcaSessionId: 'claude_dd9b33e3'
      } as unknown as ResolvedAgentConversation

      const read = readAgentConversation(ctx, agent, {})

      if (refusal) {
        await expect(read).rejects.toThrow(refusal)
        expect(terminal.read).not.toHaveBeenCalled()
      } else {
        await expect(read).rejects.toThrow('transcript missing')
        expect(terminal.read).toHaveBeenCalledWith(expect.objectContaining({ wslDistro: 'Ubuntu' }))
      }
    } finally {
      if (platform) {
        Object.defineProperty(process, 'platform', platform)
      }
    }
  }
)

const codexEvent = (payload: unknown) => JSON.stringify({ type: 'event_msg', payload })
const codexRows = {
  // A current rollout's tail: the completed item, then its unrendered raw copy.
  'its own reply before a raw copy': [
    codexEvent({ type: 'task_started', turn_id: 't1' }),
    codexEvent({ type: 'user_message', message: 'reply FINISHED' }),
    codexEvent({
      type: 'item_completed',
      turn_id: 't1',
      item: { type: 'AgentMessage', id: 'm1', content: [{ type: 'Text', text: 'FINISHED' }] }
    }),
    JSON.stringify({
      type: 'response_item',
      payload: {
        type: 'message',
        id: 'm1',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'FINISHED' }]
      }
    }),
    codexEvent({ type: 'task_complete', turn_id: 't1', last_agent_message: 'FINISHED' })
  ],
  'only a previous turn reply': [
    codexEvent({ type: 'task_started', turn_id: 't1' }),
    codexEvent({ type: 'user_message', message: 'FIRST' }),
    codexEvent({ type: 'agent_message', message: 'OLD ANSWER' }),
    codexEvent({ type: 'task_complete', turn_id: 't1' }),
    codexEvent({ type: 'task_started', turn_id: 't2' }),
    JSON.stringify({
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_image', image_url: 'https://example.test/image.png' }]
      }
    }),
    codexEvent({ type: 'task_complete', turn_id: 't2', last_agent_message: 'NEW ANSWER' })
  ]
}

it.each([
  ['its own reply before a raw copy', 'reply FINISHED', 'FINISHED', 'done'],
  ['only a previous turn reply', 'FIRST', 'OLD ANSWER', undefined]
] as const)('reads a completed Codex turn with %s', async (shape, ask, answer, state) => {
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'council-codex-'))
  try {
    const path = join(dir, 'rollout.jsonl')
    writeFileSync(path, `${codexRows[shape].join('\n')}\n`)
    terminal.source.mockResolvedValue({
      key: {
        executionHost: 'local',
        wslDistro: '',
        agent: 'codex',
        providerSessionId: 'p',
        locator: ''
      },
      providerSession: { id: 'p', transcriptPath: path }
    })
    terminal.read.mockImplementation(actualTranscriptReader.readWorkerTranscript)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: terminal addressing is supplied by the mocked identity seam.
    const resolved = { kind: 'terminal', orcaSessionId: 'codex_probe' } as ResolvedAgentConversation
    const result = await readAgentConversation(ctx, resolved, {})
    expect(result).toMatchObject({
      entries: [
        { role: 'user', text: ask },
        { role: 'assistant', text: answer }
      ]
    })
    expect(result.state).toBe(state)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
