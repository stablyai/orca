import { describe, expect, it } from 'vitest'
import type { OrchestrationFleetWorker } from '../../../shared/orchestration-fleet-projection'
import { subagentGroupFallbackText } from '../../../shared/native-chat-subagent-summary'
import type {
  NativeChatBlock,
  NativeChatMessage,
  NativeChatSubagentEntry
} from '../../../shared/native-chat-types'
import type { OrchestrationWorkerReadResult } from '../../../shared/orchestration-worker-output'
import { formatWorkerRead, formatWorkerStart } from './worker-output'

function fleetProjection(verdict: 'live' | 'unverifiable' | 'exited'): OrchestrationFleetWorker {
  return {
    id: 'dispatch_1',
    dispatchId: 'dispatch_1',
    taskId: 'task_1',
    runId: 'run_1',
    role: 'worker',
    parent: null,
    provider: { id: 'codex', model: null },
    host: { kind: 'local', id: 'local' },
    workspace: { id: 'ws_1', kind: 'folder_or_worktree' },
    stage: { worker: 'ready', dispatch: 'dispatched', detail: null, activity: 'working' },
    outcome: 'in_progress',
    liveness:
      verdict === 'live'
        ? { verdict, observedAt: 1, source: 'agent_status' }
        : verdict === 'exited'
          ? { verdict, source: 'execution_host' }
          : { verdict, reason: 'missing_status' },
    evidence: { durable: true, liveStatus: 'fresh', lastObservedAt: 1 },
    resource: {
      state: 'owned',
      id: 'wtr_1',
      ownerDispatchId: 'dispatch_1',
      releaseState: 'active',
      terminalState: null
    },
    nextAction: { kind: 'inspect', argv: [] },
    attention: { categories: [], requiresAction: false }
  }
}

describe('worker-start plain formatting', () => {
  it('renders partial effects, residual resources, and exact recovery commands for unknown starts', () => {
    const nextCommands = [
      'orca orchestration worker-show --dispatch ctx_unknown --json',
      'orca orchestration worker-abandon --dispatch ctx_unknown --json'
    ]

    expect(
      formatWorkerStart({
        taskId: 'task_1',
        dispatchId: 'ctx_unknown',
        state: 'outcome_unknown',
        failedStage: 'dispatch_input',
        lastError: 'submission could not be observed',
        effects: [{ kind: 'terminal', id: 'term_worker' }],
        residualResources: [{ kind: 'terminal', id: 'term_worker' }],
        nextCommands
      })
    ).toBe(
      'Worker ctx_unknown [outcome_unknown] for task_1\n' +
        'dispatch_input: submission could not be observed\n' +
        'Effects: [{"kind":"terminal","id":"term_worker"}]\n' +
        'Residual resources: [{"kind":"terminal","id":"term_worker"}]\n' +
        `Next command: ${nextCommands[0]}\n` +
        `Next command: ${nextCommands[1]}`
    )
  })

  it('renders nonempty effects and residual resources for failed starts', () => {
    expect(
      formatWorkerStart({
        taskId: 'task_1',
        dispatchId: 'ctx_failed',
        state: 'failed',
        failedStage: 'terminal_create',
        lastError: 'terminal creation failed',
        effects: [{ kind: 'worktree', id: 'worktree_1' }],
        residualResources: [{ kind: 'worktree', id: 'worktree_1' }]
      })
    ).toBe(
      'Worker ctx_failed [failed] for task_1\n' +
        'terminal_create: terminal creation failed\n' +
        'Effects: [{"kind":"worktree","id":"worktree_1"}]\n' +
        'Residual resources: [{"kind":"worktree","id":"worktree_1"}]'
    )
  })

  it('keeps ready receipts concise when effects describe successful setup', () => {
    expect(
      formatWorkerStart({
        taskId: 'task_1',
        dispatchId: 'ctx_ready',
        state: 'ready',
        effects: [{ kind: 'terminal', id: 'term_worker' }],
        residualResources: []
      })
    ).toBe('Worker ctx_ready [ready] for task_1')
  })
})

describe('worker-read plain formatting', () => {
  it('renders transcript provenance, incomplete coverage, warnings, and opaque cursor guidance', () => {
    expect(
      formatWorkerRead(
        workerReadResult({
          source: 'transcript',
          sourceIdentity: 'private-source-identity',
          provider: 'codex',
          transcript: {
            messages: [
              {
                id: 'message_1',
                role: 'assistant',
                blocks: [{ type: 'text', text: 'latest output' }],
                timestamp: null,
                source: 'transcript'
              }
            ],
            nextCursor: 'owr1_transcript',
            limited: true,
            returnedMessageCount: 1
          },
          cursor: 'owr1_transcript',
          fallbackReason: null,
          sourceExact: true,
          contentComplete: false,
          clipping: ['message_limit_or_scan_window'],
          warnings: ['Older transcript records are not pageable through this cursor.']
        })
      )
    ).toBe(
      'Source: transcript (provider=codex)\n' +
        'Worker: ready\n' +
        'Archived: false\n' +
        'Source exact: true\n' +
        'Content complete: false\n' +
        'Clipping: message_limit_or_scan_window\n' +
        'Continuation cursor (opaque; pass unchanged to --cursor): owr1_transcript\n' +
        'Warning: Older transcript records are not pageable through this cursor.\n\n' +
        '[assistant] latest output'
    )
  })

  it('labels terminal fallback evidence and every warning', () => {
    expect(
      formatWorkerRead(
        workerReadResult({
          source: 'terminal',
          sourceIdentity: 'private-source-identity',
          terminal: {
            handle: 'term_worker',
            status: 'running',
            tail: ['bounded terminal evidence'],
            truncated: true,
            nextCursor: '20'
          },
          cursor: 'owr1_terminal',
          fallbackReason: 'session_not_reported',
          sourceExact: false,
          contentComplete: false,
          clipping: ['terminal_buffer', 'terminal_fallback'],
          warnings: ['A secret was redacted.', 'One line was malformed.']
        })
      )
    ).toBe(
      'Source: terminal\n' +
        'Worker: ready\n' +
        'Archived: false\n' +
        'Source exact: false\n' +
        'Fallback reason: session_not_reported\n' +
        'Content complete: false\n' +
        'Clipping: terminal_buffer, terminal_fallback\n' +
        'Continuation cursor (opaque; pass unchanged to --cursor): owr1_terminal\n' +
        'Warning: A secret was redacted.\n' +
        'Warning: One line was malformed.\n\n' +
        'bounded terminal evidence'
    )
  })

  it('truthfully labels an exact empty transcript without reading terminal evidence', () => {
    expect(
      formatWorkerRead(
        workerReadResult({
          source: 'transcript',
          sourceIdentity: 'private-source-identity',
          provider: 'codex',
          transcript: {
            messages: [],
            nextCursor: 'owr1_empty',
            limited: false,
            returnedMessageCount: 0
          },
          cursor: 'owr1_empty',
          fallbackReason: null,
          sourceExact: true,
          contentComplete: true,
          warnings: []
        })
      )
    ).toBe(
      'Source: transcript (provider=codex)\n' +
        'Worker: ready\n' +
        'Archived: false\n' +
        'Source exact: true\n' +
        'Content complete: true\n' +
        'Continuation cursor (opaque; pass unchanged to --cursor): owr1_empty\n\n' +
        'No transcript messages returned. This exact transcript read did not request terminal evidence.'
    )
  })
  it('separates the PTY verdict from the fleet agent verdict', () => {
    const output = formatWorkerRead({
      dispatchId: 'dispatch_1',
      status: { worker: 'ready', terminal: 'running', liveness: 'live' },
      projection: fleetProjection('unverifiable'),
      source: 'terminal',
      sourceIdentity: 'private-source-identity',
      terminal: {
        handle: 'term_worker',
        status: 'running',
        tail: ['tail'],
        truncated: false,
        nextCursor: null
      },
      cursor: null,
      fallbackReason: null,
      warnings: []
    })

    expect(output).toContain('Terminal liveness: live')
    expect(output).toContain('Agent liveness: unverifiable')
    expect(output).not.toMatch(/^Liveness:/mu)
  })

  it('omits the agent verdict when the host published no projection', () => {
    const output = formatWorkerRead({
      dispatchId: 'dispatch_1',
      status: { worker: 'ready', terminal: 'running', liveness: 'live' },
      source: 'terminal',
      sourceIdentity: 'private-source-identity',
      terminal: {
        handle: 'term_worker',
        status: 'running',
        tail: ['tail'],
        truncated: false,
        nextCursor: null
      },
      cursor: null,
      fallbackReason: null,
      warnings: []
    })

    expect(output).toContain('Terminal liveness: live')
    expect(output).not.toContain('Agent liveness:')
  })

  it('distinguishes a released archive read from a live one', () => {
    const output = formatWorkerRead({
      dispatchId: 'dispatch_1',
      status: { worker: 'succeeded', terminal: 'released', liveness: 'unverifiable' },
      source: 'terminal',
      sourceIdentity: 'private-source-identity',
      terminal: {
        handle: 'term_worker',
        status: 'exited',
        tail: ['archived tail'],
        truncated: false,
        nextCursor: null
      },
      cursor: null,
      fallbackReason: null,
      warnings: [],
      archived: true
    } as unknown as OrchestrationWorkerReadResult)

    expect(output).toContain('Archived: true')
    expect(output).toContain('Terminal liveness: unverifiable')
    expect(output).toContain('Worker: succeeded')
  })
})

function workerReadResult(
  value: WorkerReadResultWithoutContext<OrchestrationWorkerReadResult>
): OrchestrationWorkerReadResult {
  return {
    dispatchId: 'dispatch_1',
    status: { worker: 'ready', terminal: 'running' },
    ...value
  } as OrchestrationWorkerReadResult
}

type WorkerReadResultWithoutContext<T> = T extends unknown
  ? Omit<T, 'dispatchId' | 'status'>
  : never

function transcriptRead(
  blocks: NativeChatBlock[],
  role: NativeChatMessage['role'] = 'assistant'
): OrchestrationWorkerReadResult {
  const message: NativeChatMessage = {
    id: 'm1',
    role,
    blocks,
    timestamp: 1,
    source: 'transcript'
  }
  return {
    dispatchId: 'd1',
    source: 'transcript',
    sourceIdentity: 'pane:1',
    provider: 'codex',
    transcript: { messages: [message], nextCursor: '1', limited: false, returnedMessageCount: 1 },
    cursor: '1',
    status: { worker: 'running', terminal: 'running' },
    fallbackReason: null,
    warnings: []
  }
}

const ROSTER: readonly NativeChatSubagentEntry[] = [
  { id: 'child-1', label: 'read', state: 'working' },
  { id: 'child-2', label: 'edit', state: 'failed' }
]

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1
}

describe('formatWorkerRead', () => {
  // The replay case this row is durable for: SQLite-backed, re-sent on every
  // reconnect, and read here by a client that draws no roster block, runs no
  // reconciliation, and cannot re-check whether those children still exist. A
  // sentence frozen mid-flight outlives the process that wrote it, so it must
  // not keep asserting a liveness only that process could have observed —
  // `docs/reference/ssh-execution-boundary.md` calls that loss of contact
  // reported as a live state.
  it('replays a mid-flight roster row without claiming a child is still working', () => {
    const midFlight: readonly NativeChatSubagentEntry[] = [
      { id: 'child-1', label: 'read', state: 'working' },
      { id: 'child-2', label: 'search', state: 'working' },
      { id: 'child-3', label: 'edit', state: 'failed' }
    ]

    const output = formatWorkerRead(
      transcriptRead([
        { type: 'text', text: subagentGroupFallbackText(midFlight) },
        { type: 'subagent-group', groupId: 'thread:turn-1', agents: [...midFlight] }
      ])
    )

    expect(output).toContain('[assistant] Kicked off 3 subagents (1 failed)')
    expect(output).not.toMatch(/\bworking\b/)
  })

  // The body `codexSubagentGroupBody` actually writes: the plain-text twin, then
  // the block it stands in for. The twin exists for clients that cannot draw the
  // block, so a client printing the block must not print the twin beside it —
  // the renderer drops the twin for the same reason, from the other side.
  it('prints the roster sentence once for the two-block row the producer writes', () => {
    const sentence = subagentGroupFallbackText(ROSTER)
    const output = formatWorkerRead(
      transcriptRead(
        [
          { type: 'text', text: sentence },
          { type: 'subagent-group', groupId: 'thread:turn-1', agents: [...ROSTER] }
        ],
        'system'
      )
    )

    expect(output).toContain(`[system] ${sentence}`)
    expect(occurrences(output, sentence)).toBe(1)
  })

  // Suppression is per twin, not per message. One twin beside two roster blocks
  // silenced BOTH groups and printed one sentence, so the second roster vanished
  // with no marker — the same silent drop the missing-twin case above avoids.
  it('stands in for the second roster block when only one twin accompanies two', () => {
    const other: readonly NativeChatSubagentEntry[] = [
      { id: 'child-3', label: 'plan', state: 'completed' }
    ]
    const output = formatWorkerRead(
      transcriptRead(
        [
          { type: 'text', text: subagentGroupFallbackText(ROSTER) },
          { type: 'subagent-group', groupId: 'thread:turn-1', agents: [...ROSTER] },
          { type: 'subagent-group', groupId: 'thread:turn-2', agents: [...other] }
        ],
        'system'
      )
    )

    expect(occurrences(output, subagentGroupFallbackText(ROSTER))).toBe(1)
    expect(output).toContain(`[subagents] ${subagentGroupFallbackText(other)}`)
  })

  // Which group a lone twin belongs to is decided by its TEXT, not its position.
  // Claiming positionally silenced whichever group came first, so a twin
  // belonging to a LATER group erased the earlier group's roster and printed the
  // later one's sentence twice — the same silent drop, one permutation over.
  it('claims a lone twin for the group it names, not the first group in the message', () => {
    const other: readonly NativeChatSubagentEntry[] = [
      { id: 'child-3', label: 'plan', state: 'completed' }
    ]
    const second = subagentGroupFallbackText(other)
    const output = formatWorkerRead(
      transcriptRead(
        [
          { type: 'text', text: second },
          { type: 'subagent-group', groupId: 'thread:turn-1', agents: [...ROSTER] },
          { type: 'subagent-group', groupId: 'thread:turn-2', agents: [...other] }
        ],
        'system'
      )
    )

    expect(occurrences(output, second)).toBe(1)
    expect(output).toContain(`[subagents] ${subagentGroupFallbackText(ROSTER)}`)
  })

  // The same claim, with the twin written after both blocks: nothing about the
  // ORDER of a twin and its group is guaranteed by the block schema.
  it('claims a trailing twin for the group it names', () => {
    const other: readonly NativeChatSubagentEntry[] = [
      { id: 'child-3', label: 'plan', state: 'completed' }
    ]
    const second = subagentGroupFallbackText(other)
    const output = formatWorkerRead(
      transcriptRead(
        [
          { type: 'subagent-group', groupId: 'thread:turn-1', agents: [...ROSTER] },
          { type: 'subagent-group', groupId: 'thread:turn-2', agents: [...other] },
          { type: 'text', text: second }
        ],
        'system'
      )
    )

    expect(occurrences(output, second)).toBe(1)
    expect(output).toContain(`[subagents] ${subagentGroupFallbackText(ROSTER)}`)
  })

  // A group with no twin beside it is a shape the block schema admits and no
  // producer writes. Dropping it would lose the roster entirely, so the block
  // itself carries the sentence when nothing else does.
  it('stands in for a roster block that arrived without its twin', () => {
    const output = formatWorkerRead(
      transcriptRead([{ type: 'subagent-group', groupId: 'thread:turn-1', agents: [...ROSTER] }])
    )

    expect(output).toContain(`[assistant] [subagents] ${subagentGroupFallbackText(ROSTER)}`)
  })

  // A roster from a newer build holds a state this build does not know, which
  // `summarizeSubagentGroup` reads as `unverifiable`. Recomputing the sentence
  // to compare it against the frozen twin therefore produced a DIFFERENT string,
  // and the CLI printed the roster twice: the twin's own wording plus a
  // `[subagents]` line contradicting it.
  it('prints the roster once when the twin names a state this build cannot reproduce', () => {
    const frozenTwin = 'Ran 2 subagents (1 cancelled)'
    const output = formatWorkerRead(
      transcriptRead(
        [
          { type: 'text', text: frozenTwin },
          {
            type: 'subagent-group',
            groupId: 'thread:turn-1',
            agents: [
              { id: 'child-1', label: 'read', state: 'completed' },
              { id: 'child-2', label: 'edit', state: 'cancelled' }
            ] as unknown as NativeChatSubagentEntry[]
          }
        ],
        'system'
      )
    )

    expect(output).toContain(`[system] ${frozenTwin}`)
    expect(output).not.toContain('[subagents]')
    expect(output).not.toContain('unverifiable')
  })

  // The journal admits block types this build does not know, and `client.call`
  // casts the RPC result rather than validating it — so a newer remote host's
  // block reaches this formatter as-is. Reading fields off it threw a TypeError
  // and took down the whole `worker read`.
  it('degrades an unknown block type from a newer host instead of throwing', () => {
    const output = formatWorkerRead(
      transcriptRead([
        { type: 'text', text: 'before' },
        { type: 'plan-step', title: 'ship it' } as unknown as NativeChatBlock,
        { type: 'text', text: 'after' }
      ])
    )

    expect(output).toContain('[assistant] before\n[unsupported block]\nafter')
  })
})
