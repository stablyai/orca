import { expect, it, vi } from 'vitest'
import type { AgentSessionAttachParams } from '../../../native-chat/agent-session-wire/structured-agent-session-attach'
import type { StructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-host'
import { recordingStructuredAgentSessionLogger } from '../../../native-chat/agent-session-wire/structured-agent-session-logger-test-support'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { commitStructuredAgentSessionCreate } from './structured-agent-session-create'

// A chat created whose tab could not be published is answered as unconfirmed; the cause is logged.
it('logs a created chat whose tab could not be published, and answers it unconfirmed', async () => {
  const log = recordingStructuredAgentSessionLogger()
  const failure = new Error('tab write failed')
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the stub implements the only members the commit reaches past attach.
  const host = {
    attach: vi.fn(async () => ({ ok: true, value: { sessionId: 'session-1' } })),
    getSessionTabId: vi.fn(() => null),
    deps: { logger: log.logger }
  } as unknown as StructuredAgentSessionHost
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the commit reaches only the tab publication on the runtime.
  const runtime = {
    publishStructuredAgentSessionTab: vi.fn(async () => {
      throw failure
    })
  } as unknown as OrcaRuntimeService

  const result = await commitStructuredAgentSessionCreate({
    runtime,
    caller: { callerKey: 'client-1' },
    prepared: {
      host,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the stubbed attach reads none of it.
      attachParams: {} as AgentSessionAttachParams,
      tab: { workspaceId: 'workspace-1', agent: 'codex' }
    },
    activate: true
  })

  expect(result).toMatchObject({ ok: false, refusal: { details: { reason: 'tabUnconfirmed' } } })
  expect(log.entries.map((entry) => entry.fields)).toEqual([
    { scope: 'create-tab-publication', sessionId: 'session-1', error: failure }
  ])
})
