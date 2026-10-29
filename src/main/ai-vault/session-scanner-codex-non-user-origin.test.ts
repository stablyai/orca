import { describe, expect, it } from 'vitest'
import { readCodexNonUserOrigin } from './session-scanner-codex-non-user-origin'

// Mirror the provider union: spawn fields nest under thread_spawn and may also be copied onto the payload.
function spawnedPayload(threadSpawn: unknown, payloadCopies: Record<string, unknown> = {}) {
  return {
    id: 'child-thread',
    cwd: '/repo/app',
    thread_source: 'subagent',
    source: { subagent: { thread_spawn: threadSpawn } },
    ...payloadCopies
  }
}

describe('readCodexNonUserOrigin', () => {
  it('keeps every field of a stated spawn record, including a null role', () => {
    const origin = readCodexNonUserOrigin(
      spawnedPayload({
        parent_thread_id: '01a06e83-42af-7741-b975-ab54925540f9',
        depth: 1,
        agent_path: '/root/readiness_final_fresh',
        agent_nickname: 'Pascal',
        agent_role: null
      })
    )

    expect(origin).toEqual({
      source: 'subagent',
      kind: 'thread_spawn',
      kindLabel: null,
      threadSource: 'subagent',
      parentage: {
        parentThreadId: '01a06e83-42af-7741-b975-ab54925540f9',
        depth: 1,
        agentNickname: 'Pascal',
        agentRole: null,
        agentPath: '/root/readiness_final_fresh'
      }
    })
  })

  it('reads the agent_type spelling of the role, nested and on the payload', () => {
    expect(readCodexNonUserOrigin(spawnedPayload({ agent_type: 'explorer' }))?.parentage).toEqual({
      parentThreadId: null,
      depth: null,
      agentNickname: null,
      agentRole: 'explorer',
      agentPath: null
    })
    expect(
      readCodexNonUserOrigin(spawnedPayload({}, { agent_type: 'reviewer' }))?.parentage?.agentRole
    ).toBe('reviewer')
  })

  it('reads the role the payload copied beside the spawn record', () => {
    expect(
      readCodexNonUserOrigin(spawnedPayload({}, { agent_role: 'explorer' }))?.parentage?.agentRole
    ).toBe('explorer')
  })

  it('classifies a non-spawn thread by its tag instead of calling it a role', () => {
    // Review has no spawn record; its parent, if present, comes from the payload.
    const origin = readCodexNonUserOrigin({
      id: 'child-thread',
      thread_source: 'subagent',
      source: { subagent: 'review' },
      parent_thread_id: '019f49cb-7af8-7e01-946a-274c65fe6103'
    })

    expect(origin).toEqual({
      source: 'subagent',
      kind: 'review',
      kindLabel: null,
      threadSource: 'subagent',
      parentage: {
        parentThreadId: '019f49cb-7af8-7e01-946a-274c65fe6103',
        depth: null,
        agentNickname: null,
        agentRole: null,
        agentPath: null
      }
    })
  })

  it('classifies a compaction thread that states no parent at all', () => {
    expect(readCodexNonUserOrigin({ id: 'child-thread', source: { subagent: 'compact' } })).toEqual(
      {
        source: 'subagent',
        kind: 'compact',
        kindLabel: null,
        threadSource: null,
        parentage: null
      }
    )
    expect(
      readCodexNonUserOrigin({ id: 'child-thread', source: { subagent: 'memory_consolidation' } })
        ?.kind
    ).toBe('memory_consolidation')
  })

  it('keeps the label of a tag that carries free text', () => {
    expect(
      readCodexNonUserOrigin({ id: 'child-thread', source: { subagent: { other: 'gardener' } } })
    ).toEqual({
      source: 'subagent',
      kind: 'other',
      kindLabel: 'gardener',
      threadSource: null,
      parentage: null
    })
  })

  it('classifies machinery Codex ran for itself, not only agents it spawned', () => {
    // Internal machinery may omit thread_source; the structural tag must still exclude it.
    expect(
      readCodexNonUserOrigin({ id: 'child-thread', source: { internal: 'guardian' } })
    ).toEqual({
      source: 'internal',
      kind: 'guardian',
      kindLabel: null,
      threadSource: null,
      parentage: null
    })
    expect(
      readCodexNonUserOrigin({
        id: 'child-thread',
        source: { internal: 'memory_consolidation' }
      })?.kind
    ).toBe('memory_consolidation')
  })

  it('keeps every thread the user started, whatever its source tag', () => {
    for (const source of ['cli', 'vscode', 'exec', 'mcp', 'unknown', { custom: 'acme' }]) {
      expect(readCodexNonUserOrigin({ id: 'user-thread', source })).toBeNull()
    }
  })

  it('degrades field by field when a spawn record is malformed', () => {
    const origin = readCodexNonUserOrigin(
      spawnedPayload({
        parent_thread_id: 12345,
        agent_nickname: 'Mendel',
        agent_role: 'explorer'
      })
    )

    expect(origin?.parentage).toEqual({
      parentThreadId: null,
      depth: null,
      agentNickname: 'Mendel',
      agentRole: 'explorer',
      agentPath: null
    })
  })

  it('rejects a depth that contradicts being a child', () => {
    expect(readCodexNonUserOrigin(spawnedPayload({ depth: 0 }))?.parentage).toBeNull()
    expect(readCodexNonUserOrigin(spawnedPayload({ depth: 1.5 }))?.parentage).toBeNull()
    expect(readCodexNonUserOrigin(spawnedPayload({ depth: '2' }))?.parentage).toBeNull()
  })

  it('still reports the origin when no part of the spawn is readable', () => {
    const origin = readCodexNonUserOrigin(spawnedPayload(true))

    expect(origin).toEqual({
      source: 'subagent',
      kind: 'thread_spawn',
      kindLabel: null,
      threadSource: 'subagent',
      parentage: null
    })
  })

  it('reports a subagent source that states no spawn at all', () => {
    const origin = readCodexNonUserOrigin({
      id: 'child-thread',
      source: { subagent: { thread_spawn: null } }
    })

    expect(origin).toEqual({
      source: 'subagent',
      kind: 'thread_spawn',
      kindLabel: null,
      threadSource: null,
      parentage: null
    })
  })

  it('keeps a thread whose source states no readable tag at all', () => {
    for (const source of [false, true, 0, 1, '', '   ', [], {}, { a: 1, b: 2 }]) {
      expect(readCodexNonUserOrigin({ id: 'user-thread', source })).toBeNull()
    }
  })

  it('classifies on the outer tag even when the kind beneath it is unreadable', () => {
    // The outer non-user tag remains authoritative even when future releases change its contents.
    for (const subagent of [false, 0, '', [], { type: 'review', extra: 1 }]) {
      expect(readCodexNonUserOrigin({ id: 'child-thread', source: { subagent } })).toEqual({
        source: 'subagent',
        kind: null,
        kindLabel: null,
        threadSource: null,
        parentage: null
      })
    }
  })

  it('keeps a forked user thread, whose lineage is not a spawn parent', () => {
    expect(
      readCodexNonUserOrigin({
        id: 'user-thread',
        thread_source: 'user',
        forked_from_id: '019f49cb-7af8-7e01-946a-274c65fe6103'
      })
    ).toBeNull()
    expect(
      readCodexNonUserOrigin({
        id: 'user-thread',
        forked_from_id: '019f49cb-7af8-7e01-946a-274c65fe6103'
      })
    ).toBeNull()
  })

  it('lets a stated user thread_source outrank a subagent source', () => {
    expect(
      readCodexNonUserOrigin({
        id: 'user-thread',
        thread_source: 'user',
        source: { subagent: { thread_spawn: { parent_thread_id: 'other' } } }
      })
    ).toBeNull()
  })

  it('reads the camelCase thread_source spelling', () => {
    expect(readCodexNonUserOrigin({ id: 'child', threadSource: 'subagent' })).toEqual({
      source: null,
      kind: null,
      kindLabel: null,
      threadSource: 'subagent',
      parentage: null
    })
  })

  it('keeps top-level threads whose thread_source is a client feature label', () => {
    // Codex Desktop automation runs and agent-created threads are the user's own work.
    for (const threadSource of ['automation', 'agent_created_thread']) {
      expect(
        readCodexNonUserOrigin({ id: 'run', source: 'vscode', thread_source: threadSource })
      ).toBeNull()
    }
    expect(
      readCodexNonUserOrigin({ id: 'review', thread_source: 'guardian_review' })?.threadSource
    ).toBe('guardian_review')
  })
})
