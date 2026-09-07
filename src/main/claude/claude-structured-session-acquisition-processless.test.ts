import { describe, expect, it, vi } from 'vitest'
import type { AgentSessionJournalIdentity } from '../../shared/agent-session-journal-types'
import { AgentSessionPreSpawnError } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import type {
  ClaudeStreamJsonConnection,
  openClaudeStreamJsonConnection
} from './claude-stream-json-connection'
import { ClaudeStructuredSessionAdapter } from './claude-structured-session-adapter'

const PROVIDER_SESSION_ID = '819cf9f8-e43c-4ad7-b50f-54aa158a726a'
const IDENTITY: AgentSessionJournalIdentity = {
  sessionId: 'session-processless',
  workspaceId: 'workspace-1',
  hostId: 'local',
  agent: 'claude',
  providerHandle: { kind: 'opaque', agent: 'claude', value: 'pending' }
}

describe('Claude structured processless acquisition', () => {
  it('classifies pre-pid error and close as processless with idempotent cleanup', async () => {
    const fault = new Error('spawn claude ENOENT')
    const close = vi.fn(async () => true)
    const openConnection: typeof openClaudeStreamJsonConnection = async (
      _launch,
      handlers = {}
    ) => {
      const connection: ClaudeStreamJsonConnection = {
        pid: undefined,
        closed: true,
        exitVerdict: { root: 'processless', tree: 'exited' },
        initializationResult: async () => {
          handlers.onFault?.(fault)
          throw fault
        },
        getSettings: async () => ({}),
        supportedModels: async () => [],
        interrupt: async () => undefined,
        cancelAsyncMessage: async () => {},
        setModel: async () => {},
        setPermissionMode: async () => {},
        applyFlagSettings: async () => {},
        send: async () => {},
        stopTask: async () => {},
        close
      }
      return connection
    }
    const adapter = new ClaudeStructuredSessionAdapter({
      resolveLaunch: async () => ({
        pathToClaudeCodeExecutable: 'claude',
        options: {},
        cwd: '/work/repo',
        claudeConfigDir: '/accounts/claude',
        providerSessionId: PROVIDER_SESSION_ID,
        resumeLeafUuid: null,
        resumed: false
      }),
      openConnection
    })

    const error = await adapter
      .acquire({ identity: IDENTITY, fence: 7, spawnToken: 'spawn-9' })
      .catch((cause: unknown) => cause)

    expect(error).toBeInstanceOf(AgentSessionPreSpawnError)
    expect(error).toMatchObject({ message: fault.message })
    expect(close).toHaveBeenCalledOnce()
    await expect(adapter.releaseAcquisition({ sessionId: IDENTITY.sessionId })).resolves.toBe(true)
    expect(close).toHaveBeenCalledOnce()
  })
})
