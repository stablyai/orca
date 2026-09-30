import { describe, expect, it } from 'vitest'
import { readCodexNonUserOrigin } from './session-scanner-codex-non-user-origin'

// Payload shapes below mirror real `session_meta` records: `source.subagent` is
// an externally tagged union, so the spawn record nests under a `thread_spawn`
// tag and the parent, nickname and path are copied onto the payload's own keys
// beside it.
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

  it('carries the depth of a nested child instead of flattening it', () => {
    const origin = readCodexNonUserOrigin(
      spawnedPayload({
        parent_thread_id: 'middle-thread',
        depth: 2,
        agent_path: '/root/pr_review_pass_1/adversarial_correctness',
        agent_nickname: 'Noether',
        agent_role: 'explorer'
      })
    )

    expect(origin?.parentage?.depth).toBe(2)
    expect(origin?.parentage?.parentThreadId).toBe('middle-thread')
    expect(origin?.parentage?.agentRole).toBe('explorer')
  })

  it('keeps the rest of the spawn when the naming path is null', () => {
    const origin = readCodexNonUserOrigin(
      spawnedPayload({
        parent_thread_id: 'user-thread',
        depth: 1,
        agent_path: null,
        agent_nickname: 'Laplace',
        agent_role: 'explorer'
      })
    )

    expect(origin?.parentage).toEqual({
      parentThreadId: 'user-thread',
      depth: 1,
      agentNickname: 'Laplace',
      agentRole: 'explorer',
      agentPath: null
    })
  })

  it('reads the agent_type spelling of the role, nested and on the payload', () => {
    // Codex documents `agent_type` as an alias of `agent_role` in both places.
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
    // `review`, `compact` and `memory_consolidation` are sibling tags naming the
    // sort of non-user thread. They are not the spawned agent's role — that
    // field exists only inside a spawn record — and the parent, when there is
    // one, is stated on the payload's own key.
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
    // `internal` is the other non-user branch of the same union. Its threads
    // land in the same history tree and state no spawn record, and a release
    // that omits `thread_source` leaves the tag as the only signal there is.
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
    // Codex's runtime groups these with spawn records as real agent sessions,
    // so none of them is machinery and none may be hidden. `custom` carries a
    // label and is still the user's own.
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

    // The unreadable parent and the absent depth do not cost the two fields the
    // record does state.
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

  it('reads no origin from a user thread', () => {
    expect(
      readCodexNonUserOrigin({ id: 'user-thread', thread_source: 'user', source: 'cli' })
    ).toBeNull()
    expect(readCodexNonUserOrigin({ id: 'user-thread', source: 'vscode' })).toBeNull()
    expect(readCodexNonUserOrigin({ id: 'user-thread' })).toBeNull()
  })

  it('keeps a thread whose source states no readable tag at all', () => {
    // A tagged union spells a tag as a bare string or a single-key object, so
    // none of these is one and none says the thread is not the user's. Reading
    // one as a spawn would drop their own thread out of their history on a
    // value that states nothing.
    for (const source of [false, true, 0, 1, '', '   ', [], {}, { a: 1, b: 2 }]) {
      expect(readCodexNonUserOrigin({ id: 'user-thread', source })).toBeNull()
    }
  })

  it('classifies on the outer tag even when the kind beneath it is unreadable', () => {
    // The outer tag is the discriminant: only a non-user source serializes
    // under this key, so it states the thread is not the user's on its own. The
    // kind beneath it is detail that later releases may respell, and losing the
    // spelling must not leak every worker transcript into the user's history.
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
    // `forked_from_id` and `parent_thread_id` are separate co-existing keys
    // meaning different things. A forked thread is still the user's own.
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
    expect(readCodexNonUserOrigin({ id: 'child', threadSource: 'agent' })).toEqual({
      source: null,
      kind: null,
      kindLabel: null,
      threadSource: 'agent',
      parentage: null
    })
  })
})
