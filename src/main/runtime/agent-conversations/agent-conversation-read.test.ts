import { beforeEach, expect, it, vi } from 'vitest'
import type { RpcContext } from '../rpc/core'
import { readAgentConversation } from './agent-conversation-read'
import type { ResolvedAgentConversation } from './agent-conversation-address'

const terminal = vi.hoisted(() => ({
  source: vi.fn(),
  start: vi.fn(),
  read: vi.fn()
}))
vi.mock('../../agent-hooks/server/agent-hook-server', () => ({
  agentHookServer: { terminalAgentTranscriptSource: terminal.source }
}))
vi.mock('../orchestration/workers/transcripts/worker-transcript-read', () => ({
  canReadWorkerTranscript: () => true,
  readWorkerTranscript: terminal.read
}))

vi.mock('../../wsl/execution/wsl-exe-process', () => ({ runWslExe: terminal.start }))
vi.mock('../../wsl/discovery/wsl-background-distro-gate', () => ({
  readWslDistroRunningState: async () => 'stopped',
  noteWslDistroWoken: () => {}
}))
beforeEach(() => {
  vi.clearAllMocks()
  terminal.start.mockResolvedValue('')
})

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

it('names the attested distro and next step when that distro cannot start', async () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
  Object.defineProperty(process, 'platform', { value: 'win32' })
  try {
    terminal.source.mockResolvedValue({
      key: {
        executionHost: 'local',
        wslDistro: 'Ubuntu',
        agent: 'claude',
        providerSessionId: 'p',
        locator: ''
      },
      providerSession: { key: 'session_id', id: 'p', transcriptPath: '/home/qa/p.jsonl' }
    })
    terminal.start.mockRejectedValue(new Error('failed'))
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this terminal read uses only its id.
    const agent = {
      kind: 'terminal',
      orcaSessionId: 'claude_dd9b33e3'
    } as unknown as ResolvedAgentConversation
    await expect(readAgentConversation(ctx, agent, {})).rejects.toMatchObject({
      code: 'agent_no_transcript'
    })
    expect(terminal.read).not.toHaveBeenCalled()
  } finally {
    Object.defineProperty(process, 'platform', platform)
  }
})
