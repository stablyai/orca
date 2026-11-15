import type * as TranscriptReadModule from '../orchestration/workers/transcripts/worker-transcript-read'
import { expect, it, vi } from 'vitest'
import type { RpcContext } from '../rpc/core'
import { readAgentConversation } from './agent-conversation-read'
import type { ResolvedAgentConversation } from './agent-conversation-address'

const terminal = vi.hoisted(() => ({
  source: vi.fn(),
  read: vi.fn(),
  host: vi.fn()
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
  requireInstalledStructuredHost: terminal.host
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

it.each(['missing', 'unreadable', 'loop'] as const)(
  'refuses a %s /clear successor instead of reading the old root',
  async (failure) => {
    const root = {
      sessionId: 'root',
      provider: 'codex',
      conversationCommand: {
        command: 'clear',
        phase: 'committed',
        replacementSessionId: 'successor'
      }
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only the lineage fields are read before this refusal.
    const resolved = {
      kind: 'chat',
      orcaSessionId: 'codex_root',
      record: root,
      store: {
        getRecord: (id: string) => {
          if (id === 'root') {
            return root
          }
          if (failure === 'unreadable') {
            throw new Error('unreadable')
          }
          return failure === 'loop'
            ? {
                ...root,
                sessionId: 'successor',
                conversationCommand: {
                  command: 'clear',
                  phase: 'committed',
                  replacementSessionId: 'root'
                }
              }
            : null
        }
      }
    } as unknown as ResolvedAgentConversation
    await expect(readAgentConversation(ctx, resolved, {})).rejects.toMatchObject({
      code: 'agent_unavailable'
    })
    expect(terminal.host).not.toHaveBeenCalled()
  }
)

it('Codex completion cannot certify a previous turn reply after projection', async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'council-codex-'))
  try {
    const path = join(dir, 'rollout.jsonl')
    const event = (payload: unknown) => JSON.stringify({ type: 'event_msg', payload })
    const rows = [
      event({ type: 'task_started', turn_id: 't1' }),
      event({ type: 'user_message', message: 'FIRST' }),
      event({ type: 'agent_message', message: 'OLD ANSWER' }),
      event({ type: 'task_complete', turn_id: 't1' }),
      event({ type: 'task_started', turn_id: 't2' }),
      JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_image', image_url: 'https://example.test/image.png' }]
        }
      }),
      event({ type: 'task_complete', turn_id: 't2', last_agent_message: 'NEW ANSWER' })
    ]
    writeFileSync(path, `${rows.join('\n')}\n`)
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
        { role: 'user', text: 'FIRST' },
        { role: 'assistant', text: 'OLD ANSWER' }
      ]
    })
    expect(result.state).toBeUndefined()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
