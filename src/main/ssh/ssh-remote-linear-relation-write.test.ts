import { describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { RpcDispatcher } from '../runtime/rpc/dispatcher'
import { LINEAR_AGENT_ACCESS_METHODS } from '../runtime/rpc/methods/linear-agent-access'
import { dispatchRemoteLinearRelationWrite } from './ssh-remote-linear-relation-write'

describe('SSH remote Linear relation writes', () => {
  it('maps blocked-by from the current issue perspective', async () => {
    const linearIssueRelationWrite = vi.fn().mockResolvedValue({ ok: true })
    const runtime = {
      getRuntimeId: () => 'runtime-test',
      linearIssueRelationWrite
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: LINEAR_AGENT_ACCESS_METHODS })

    const response = await dispatchRemoteLinearRelationWrite(
      dispatcher,
      {
        commandPath: ['linear', 'relation', 'add'],
        flags: new Map<string, string | boolean>([
          ['id', 'ENG-1'],
          ['related', 'ENG-2'],
          ['type', 'blocked-by']
        ])
      },
      {},
      'add'
    )

    expect(response.ok).toBe(true)
    expect(linearIssueRelationWrite).toHaveBeenCalledWith({
      input: 'ENG-1',
      current: false,
      workspaceId: undefined,
      relatedInput: 'ENG-2',
      relationship: 'blockedBy',
      operation: 'add',
      context: { remote: true }
    })
  })

  it('accepts the policy-compliant rm alias', async () => {
    const linearIssueRelationWrite = vi.fn().mockResolvedValue({ ok: true })
    const runtime = {
      getRuntimeId: () => 'runtime-test',
      linearIssueRelationWrite
    } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: LINEAR_AGENT_ACCESS_METHODS })

    const response = await dispatchRemoteLinearRelationWrite(
      dispatcher,
      {
        commandPath: ['linear', 'relation', 'rm'],
        flags: new Map<string, string | boolean>([
          ['id', 'ENG-1'],
          ['related', 'ENG-2'],
          ['type', 'related']
        ])
      },
      {},
      'remove'
    )

    expect(response.ok).toBe(true)
    expect(linearIssueRelationWrite).toHaveBeenCalledWith(
      expect.objectContaining({ relationship: 'relatedTo', operation: 'remove' })
    )
  })
})
