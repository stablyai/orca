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
