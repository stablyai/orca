import { foundAgentSessionRecord } from '../../runtime/agent-session-record-founding'
import { describe, expect, it, vi } from 'vitest'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type { StructuredAgentSessionAttachContext } from './structured-agent-session-attach-context'
import { startStructuredAgentSessionAgentForOperation } from './structured-agent-session-agent-start'
import { StructuredAgentSessionAcquireAborts } from './structured-agent-session-acquire-aborts'
import { StructuredAgentSessionStartupAttempts } from './structured-agent-session-startup-attempt'
import { StructuredAgentSessionStartFlights } from './structured-agent-session-start-flight'
import { recordStructuredAgentSessionOptionIntent } from './structured-agent-session-options-read'
import { claudeAndCodexAgents } from './structured-agent-session-adapter-router-test-support'
import { recordingStructuredAgentSessionLogger } from './structured-agent-session-logger-test-support'

const SESSION = 'session-1'

describe('an operation whose agent start throws', () => {
  it('is refused as a failed restart, with the error only in the log', async () => {
    const log = recordingStructuredAgentSessionLogger()
    const cause = new Error('EACCES: permission denied, open /Users/me/.orca/leases.json')
    const context = {
      deps: {
        logger: log.logger,
        store: {
          requireWritableRecord: () =>
            foundAgentSessionRecord(
              {
                sessionId: SESSION,
                provider: 'codex',
                accountHome: { variable: 'CODEX_HOME', path: '/test/codex' },
                location: {
                  workspaceId: 'workspace-1',
                  workspaceKind: 'git-worktree',
                  executionHostId: 'local',
                  wslDistro: null
                }
              },
              { claimKeyId: 'test-key', now: 0 }
            )
        }
      },
      sessions: new Map(),
      publishStatus: vi.fn(),
      serialize: (_sessionId: string, task: () => Promise<unknown>) => task(),
      tasks: { trackAttach: (start: Promise<unknown>) => start },
      runtimeState: {
        acquireAborts: new StructuredAgentSessionAcquireAborts(),
        startFlights: new StructuredAgentSessionStartFlights(),
        startupAttempts: new StructuredAgentSessionStartupAttempts({ expire: () => {} })
      },
      reconcileLeases: () => Promise.reject(cause)
    }

    const refused = await startStructuredAgentSessionAgentForOperation(
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a partial context double; the store returns a complete record; the start throws at `reconcileLeases` before the remaining context is read.
      context as unknown as StructuredAgentSessionAttachContext,
      SESSION
    )

    expect(refused).toEqual({
      ok: false,
      failure: { kind: 'hostFault' },
      refusal: {
        code: 'agent_session_owner_restart_failed',
        message: "The agent couldn't restart."
      }
    })
    expect(log.entries.map((entry) => entry.fields)).toEqual([
      { scope: 'agent-start', sessionId: SESSION, error: cause }
    ])
  })
})

describe('an option picked while the chat is at rest', () => {
  it('refuses a key the provider would not accept as a rejected option', async () => {
    const reviseSessionOptions = vi.fn()
    const refused = await recordStructuredAgentSessionOptionIntent(
      {
        store: {
          getRecord: () =>
            // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the intent reads only the record's provider and options.
            ({ provider: 'codex', options: {} }) as unknown as AgentSessionRecord,
          replaceSessionOptions: vi.fn(),
          reviseSessionOptions
        },
        agents: claudeAndCodexAgents()
      },
      { sessionId: SESSION, fence: 1, publish: () => {}, now: () => 0 },
      { key: 'notAnOption', value: 'x' }
    )

    expect(refused).toMatchObject({
      ok: false,
      refusal: {
        code: 'agent_session_operation_invalid',
        details: { reason: 'optionRejected' }
      }
    })
    expect(reviseSessionOptions).not.toHaveBeenCalled()
  })
})
