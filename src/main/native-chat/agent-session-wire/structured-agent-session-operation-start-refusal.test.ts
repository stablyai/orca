// What an operation that needs the agent is told when it cannot have one: a typed refusal in
// words a person can read, never Orca's own error text.

import { describe, expect, it, vi } from 'vitest'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type { StructuredAgentSessionAttachContext } from './structured-agent-session-attach-context'
import { ensureStructuredAgentSessionAgentForOperation } from './structured-agent-session-agent-start'
import { recordStructuredAgentSessionOptionIntent } from './structured-agent-session-options-read'

const SESSION = 'session-1'

describe('an operation whose agent start throws', () => {
  it('is refused as a failed restart, with the error only in the log', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const cause = new Error('EACCES: permission denied, open /Users/me/.orca/leases.json')
    const context = {
      sessions: new Map(),
      reconcileLeases: () => Promise.reject(cause)
    }

    const refused = await ensureStructuredAgentSessionAgentForOperation(
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a partial context double; the start throws at `reconcileLeases`, before any other member is read.
      context as unknown as StructuredAgentSessionAttachContext,
      SESSION
    )

    expect(refused).toEqual({
      ok: false,
      refusal: {
        code: 'agent_session_owner_restart_failed',
        message: "The agent couldn't restart."
      }
    })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('starting the agent'), cause)
    warn.mockRestore()
  })
})

describe('an option picked while the chat is at rest', () => {
  it('refuses a key the provider would not accept as a rejected option', async () => {
    const persistOptions = vi.fn(async () => {})
    const refused = await recordStructuredAgentSessionOptionIntent(
      {
        getRecord: () =>
          // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the intent reads only the record's provider and options.
          ({ provider: 'codex', options: {} }) as unknown as AgentSessionRecord
      },
      { sessionId: SESSION, persistOptions, publish: () => {} },
      { key: 'notAnOption', value: 'x' }
    )

    expect(refused).toMatchObject({
      ok: false,
      refusal: {
        code: 'agent_session_operation_invalid',
        details: { reason: 'optionRejected' }
      }
    })
    expect(persistOptions).not.toHaveBeenCalled()
  })
})
