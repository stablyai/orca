import { describe, expect, it } from 'vitest'
import type { OrchestrationFleetWorker } from '../../../shared/orchestration-fleet-projection'
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
