import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { createAgentChildWorkAdmission } from '../shared/agent-status-child-work-admission'
import { createAgentStatusStore } from '../shared/agent-status-store'
import { makeStructuredAgentStatusSubject } from '../shared/agent-status-subject'

const SHARED_CORE_FILES = [
  'agent-status-child-work.ts',
  'agent-status-child-work-codec.ts',
  'agent-status-child-work-admission.ts',
  'agent-status-child-work-admission-core.ts',
  'agent-status-child-work-admission-operations.ts',
  'agent-status-child-work-alias.ts',
  'agent-status-child-work-freshness.ts',
  'agent-status-child-work-projection.ts',
  'agent-status-store.ts',
  'agent-status-store-codec.ts',
  'agent-status-store-mutation.ts',
  'agent-status-store-contract.ts',
  'agent-status-store-fact-codec.ts',
  'agent-status-store-parent.ts',
  'agent-status-store-persistence.ts',
  'agent-status-store-state.ts',
  'agent-status-store-status-codec.ts',
  'agent-status-transport-envelope.ts'
]

const trustedSubject = makeStructuredAgentStatusSubject(
  {
    executionHostId: 'ssh:relay-host-a',
    wslDistro: null,
    workspaceId: 'folder-workspace-a',
    workspaceKind: 'folder'
  },
  'session_11111111-1111-4111-8111-111111111111'
)

describe('agent status store relay context', () => {
  it('instantiates the same shared core and completes an admission/snapshot round-trip', () => {
    const authority = createAgentStatusStore({ epoch: 'relay-epoch-a', mode: 'authority' })
    expect(
      authority.applyMutation({ parent: { subject: trustedSubject, firstObservedAt: 10 } })
    ).not.toBeNull()
    const admission = createAgentChildWorkAdmission(authority, {
      mintChildWorkId: () => 'relay-child-1'
    })

    expect(
      admission.announce({
        parent: trustedSubject,
        provider: 'claude',
        aliases: [{ segmentId: 'segment-1', aliasKind: 'task_id', alias: 'task-1' }],
        fence: { invocationId: 'invocation-1', generation: 1 },
        lifetime: 'current',
        kind: 'agent',
        state: 'working',
        membership: 'live',
        observedAt: 20,
        stoppable: true,
        provenance: { source: 'transport', producerId: 'relay-fixture' }
      })
    ).toMatchObject({ accepted: true, childWorkId: 'relay-child-1' })

    const replica = createAgentStatusStore({ epoch: 'replica-placeholder', mode: 'replica' })
    expect(replica.applySnapshot(authority.getSnapshot())).toBe(true)
    expect(replica.getParent(trustedSubject)?.firstObservedAt).toBe(10)
    expect(replica.getChildren(trustedSubject)[0]?.childWorkId).toBe('relay-child-1')
  })

  it('keeps the relay-consumed core free of main, renderer and Electron imports', () => {
    for (const filename of SHARED_CORE_FILES) {
      const source = readFileSync(new URL(`../shared/${filename}`, import.meta.url), 'utf8')
      expect(source, filename).not.toMatch(
        /from\s+['"](?:electron|\.\.\/(?:main|renderer))(?:\/|['"])/
      )
      expect(source, filename).not.toMatch(/require\(['"]electron['"]\)/)
    }
  })
})
