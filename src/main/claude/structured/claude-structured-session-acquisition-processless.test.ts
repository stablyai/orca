import { AgentSessionAcquisitionExitUnprovenError } from '../../native-chat/agent-session-wire/acquisition/structured-agent-session-acquisition-errors'
import { describe, expect, it, vi } from 'vitest'
import type { AgentSessionJournalIdentity } from '../../../shared/agent-session/journal/agent-session-journal-identity'
import { AgentSessionPreSpawnError } from '../../native-chat/agent-session-wire/providers/structured-agent-session-adapter-errors'
import type {
  ClaudeStreamJsonConnection,
  openClaudeStreamJsonConnection
} from '../claude-stream-json-connection'
import { ClaudeStructuredSessionAdapter } from './claude-structured-session-adapter'

const PROVIDER_SESSION_ID = '819cf9f8-e43c-4ad7-b50f-54aa158a726a'
const IDENTITY: AgentSessionJournalIdentity = {
  sessionId: 'session-processless',
  workspaceId: 'workspace-1',
  hostId: 'local',
  agent: 'claude',
  providerHandle: null
}

describe('Claude structured processless acquisition', () => {
  it.each(['processless', 'unproven-open'] as const)(
    'retains the failed-open owner until %s cleanup is proven',
    async (mode) => {
      const fault = new Error('spawn claude ENOENT')
      let cleanupProven = mode === 'processless'
      const close = vi.fn(async () => cleanupProven)
      const openConnection: typeof openClaudeStreamJsonConnection = async (
        _launch,
        handlers = {}
      ) => {
        // A failed spawn reports its error on a later tick, as child_process does.
        if (mode === 'processless') {
          setTimeout(() => handlers.onFault?.(fault), 0)
        }
        const connection: ClaudeStreamJsonConnection = {
          pid: undefined,
          closed: true,
          exitVerdict:
            mode === 'processless'
              ? { root: 'exited', tree: 'exited', processless: true }
              : { root: 'live', tree: 'unverifiable' },
          initializationResult: async () => {
            throw fault
          },
          getSettings: async () => ({}),
          getContextUsage: async () => ({}),
          renameSession: async () => {},
          supportedModels: async () => [],
          interrupt: async () => undefined,
          cancelAsyncMessage: async () => false,
          setModel: async () => {},
          setPermissionMode: async () => {},
          applyFlagSettings: async () => {},
          send: async () => {},
          stopTask: async () => {},
          close
        }
        if (mode === 'unproven-open') {
          handlers.onConnection?.(connection)
          throw fault
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
          resumesTranscript: false,
          cliFlag: async () => 'supported' as const,
          continuesChain: false
        }),
        openConnection
      })

      const error = await adapter
        .acquire({ identity: IDENTITY, fence: 7, spawnToken: 'spawn-9' })
        .catch((cause: unknown) => cause)

      if (mode === 'unproven-open') {
        expect(error).toBeInstanceOf(AgentSessionAcquisitionExitUnprovenError)
        await expect(adapter.releaseAcquisition({ sessionId: IDENTITY.sessionId })).resolves.toBe(
          false
        )
        cleanupProven = true
        await expect(adapter.releaseAcquisition({ sessionId: IDENTITY.sessionId })).resolves.toBe(
          true
        )
      } else {
        expect(error).toBeInstanceOf(AgentSessionPreSpawnError)
        expect(error).toMatchObject({ message: fault.message })
        expect(close).toHaveBeenCalledOnce()
        await expect(adapter.releaseAcquisition({ sessionId: IDENTITY.sessionId })).resolves.toBe(
          true
        )
        expect(close).toHaveBeenCalledOnce()
      }
    }
  )
})
