import { describe, expect, it } from 'vitest'
import { agentSessionProviderHandleChainHead } from '../../../shared/agent-session/lifecycle/agent-session-provider-handle'
import type { AgentSessionRecord } from '../../../shared/agent-session/lifecycle/agent-session-record'
import type { AgentSessionRewindRecord } from '../../../shared/agent-session/lifecycle/agent-session-rewind'
import { rewindProviderChain } from './agent-session-rewind-completion'

const SOURCE = '/home/dev/.pi/agent/sessions/--project--/2026-10-27T10-06-00-396Z_source.jsonl'
const FORK = '/home/dev/.pi/agent/sessions/--project--/2026-10-27T10-15-10-112Z_fork.jsonl'

describe('rewind completion', () => {
  it('records a Pi fork, named by its session file path, as the new head', () => {
    const record: Pick<AgentSessionRecord, 'providerHandleChain'> = {
      providerHandleChain: [
        {
          linkId: 'link-1',
          handle: { transport: 'jsonl-rpc', agent: 'pi', nativeId: SOURCE },
          origin: 'created',
          mintedAtFence: 1,
          observedAt: 1
        }
      ]
    }
    const rewind: Pick<AgentSessionRewindRecord, 'providerFork'> = {
      providerFork: {
        sessionId: FORK,
        sourceSessionId: SOURCE,
        replacesSessionId: SOURCE,
        materialized: true
      }
    }

    const head = agentSessionProviderHandleChainHead(rewindProviderChain(record, rewind, 2))

    expect(head).toMatchObject({ origin: 'forked', handle: { agent: 'pi', nativeId: FORK } })
    expect(head?.linkId).toMatch(/^rewind-[0-9a-f]{40}$/)
  })
})
