import { describe, expect, it, vi } from 'vitest'
import { eraseRpcMethods, type RpcContext } from '../../core'
import { OrcaRuntimeService } from '../../../orca-runtime'
import { AUTOMATION_METHODS } from './automations'

import type { AutomationRun } from '../../../../../shared/automations/history/automation-run'

const REQUEST_ID = 'request-1'
// Each escaped control character costs six reply bytes; the emoji is a surrogate pair.
const OUTPUT = `${'\u0001'.repeat(7_999)}😀${'é'.repeat(12_000)}`

function run(index: number, title = 'Nightly run'): AutomationRun {
  return {
    id: `run-${String(index).padStart(3, '0')}`,
    automationId: 'a1',
    title,
    scheduledFor: 1_000 - index,
    status: 'completed',
    trigger: 'scheduled',
    workspaceId: null,
    sessionKind: 'terminal',
    chatSessionId: null,
    terminalSessionId: null,
    terminalPaneKey: null,
    terminalPtyId: null,
    completionAttribution: null,
    outputSnapshot: { format: 'plain_text', content: OUTPUT, capturedAt: 5, truncated: false },
    precheckResult: {
      command: 'check',
      exitCode: 1,
      timedOut: false,
      durationMs: 1,
      stdout: '\u0002'.repeat(4_000),
      stderr: '\u0003'.repeat(4_000),
      stdoutTruncated: true,
      stderrTruncated: true,
      error: null,
      startedAt: 1,
      completedAt: 2
    },
    usage: null,
    error: '\u0004'.repeat(4_000),
    startedAt: null,
    dispatchedAt: null,
    createdAt: 1_000 - index
  }
}

function runtimeWith(runs: AutomationRun[]) {
  const store = {
    listAutomationRuns: vi.fn(() => runs),
    assertAutomationOwnerFence: vi.fn(
      ({ expectedOwner }: { expectedOwner?: { selector: { kind: string } } }) => {
        if (expectedOwner && expectedOwner.selector.kind !== 'self') {
          throw new Error('automation_owner_changed')
        }
      }
    )
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: run reads touch only these two store members.
  return new OrcaRuntimeService(store as never)
}

async function runs(runtime: OrcaRuntimeService, params: Record<string, unknown>) {
  const method = eraseRpcMethods(AUTOMATION_METHODS).find(
    (entry) => entry.name === 'automation.runs'
  )
  const parsed = method!.params!.parse(params)
  const context: RpcContext = { runtime, requestId: REQUEST_ID }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: erased handlers return unknown; these are automation.runs' reply shapes.
  return (await method!.handler(parsed, context)) as {
    runs?: AutomationRun[]
    nextCursor?: string | null
    run?: AutomationRun
  }
}

describe('automation.runs previews', () => {
  it('refuses a row that cannot fit one reply instead of sending it', async () => {
    const runtime = runtimeWith([run(0, 'x'.repeat(5 * 1024 * 1024))])
    await expect(runs(runtime, { automationId: 'a1', preview: true })).rejects.toThrow(
      'too large to list'
    )
  })
})
