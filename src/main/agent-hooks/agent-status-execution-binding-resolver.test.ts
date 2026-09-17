import { describe, expect, it } from 'vitest'
import { ClaimedAgentPtyOwnerRegistry } from '../../shared/claimed-agent-pty-owner'
import type { AgentStatusExecutionBinding } from '../../shared/agent-status-run'
import { makePaneKey } from '../../shared/stable-pane-id'
import { createAgentStatusExecutionBindingResolver } from './agent-status-execution-binding-resolver'

const PANE_KEY = makePaneKey('tab-1', '11111111-1111-4111-8111-111111111111')
const WORKTREE_ID = 'repo::/tmp/worktree'

function owner(ptyId: string, executionId: string, runId: string) {
  return {
    claim: {
      digestVersion: 1 as const,
      keyId: 'key-id',
      identityDigest: 'a'.repeat(43),
      worktreeScopeDigest: 'b'.repeat(43),
      agent: 'codex' as const
    },
    generation: `generation-${ptyId}`,
    phase: 'live' as const,
    ptyId,
    surface: {
      worktreeId: WORKTREE_ID,
      tabId: 'tab-1',
      leafId: '11111111-1111-4111-8111-111111111111',
      terminalHandle: `term_${ptyId}`
    },
    statusBinding: { runId, attachment: { executionId }, role: 'root' as const }
  }
}

describe('agent status execution binding resolver', () => {
  it('accepts an exact live owner binding on the same surface', () => {
    const owners = new ClaimedAgentPtyOwnerRegistry()
    owners.register(owner('pty-a', 'execution-a', 'run-a'))

    const resolved = createAgentStatusExecutionBindingResolver(owners)({
      paneKey: PANE_KEY,
      worktreeId: WORKTREE_ID,
      source: 'codex',
      reported: { runId: 'run-a', executionId: 'execution-a' }
    })

    expect(resolved).toEqual({
      runId: 'run-a',
      attachment: { executionId: 'execution-a' },
      role: 'root'
    })
  })

  it('rejects mismatched and cross-surface claims', () => {
    const owners = new ClaimedAgentPtyOwnerRegistry()
    owners.register(owner('pty-a', 'execution-a', 'run-a'))

    const resolve = createAgentStatusExecutionBindingResolver(owners)
    expect(
      resolve({
        paneKey: PANE_KEY,
        worktreeId: WORKTREE_ID,
        source: 'codex',
        reported: { runId: 'run-a', executionId: 'wrong' }
      })
    ).toBeNull()
    expect(
      resolve({
        paneKey: makePaneKey('tab-other', '11111111-1111-4111-8111-111111111111'),
        worktreeId: WORKTREE_ID,
        source: 'codex',
        reported: { runId: 'run-a', executionId: 'execution-a' }
      })
    ).toBeNull()
    expect(
      resolve({
        paneKey: PANE_KEY,
        worktreeId: WORKTREE_ID,
        source: 'codex',
        emitterRole: 'child',
        reported: { runId: 'run-a', executionId: 'execution-a' }
      })
    ).toBeNull()
  })

  it('accepts a matching claim while the owner transaction is still reserved', async () => {
    const owners = new ClaimedAgentPtyOwnerRegistry()
    let reservedBinding: AgentStatusExecutionBinding | undefined
    let finishSpawn!: (result: { ptyId: string }) => void
    const reservedOwner = owner('pty-reserved', 'execution-reserved', 'run-reserved')
    const ensure = owners.ensure({
      claim: reservedOwner.claim,
      surface: reservedOwner.surface,
      spawn: async ({ statusBinding }) => {
        reservedBinding = statusBinding
        return new Promise<{ ptyId: string }>((resolve) => {
          finishSpawn = resolve
        })
      }
    })
    await Promise.resolve()
    const binding = reservedBinding
    if (!binding) {
      throw new Error('expected reservation binding')
    }
    const resolved = createAgentStatusExecutionBindingResolver(owners)({
      paneKey: PANE_KEY,
      worktreeId: WORKTREE_ID,
      source: 'codex',
      reported: { runId: binding.runId, executionId: binding.attachment.executionId }
    })

    expect(resolved).toEqual(binding)
    finishSpawn({ ptyId: 'pty-reserved' })
    await expect(ensure).resolves.toMatchObject({ disposition: 'created' })
  })
})
