import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { readScenarios } from '../scenario-input'
import { readGolden } from '../golden-recording'
import { runRecording, runRecordingMutant } from '../run-recording'
import { materializeScenario } from '../scenario-execution-mode'
import { RecordingParamsMismatch } from '../recording-mismatch'
import { ScriptedRpcTransport } from '../scripted-rpc-transport'
import { DEVICE_TOKEN } from '../scripted-rpc-device'
import { captureValue } from '../recording-values'
import type { RecordingScenario } from '../recording-scenario'
import { pilotMountAdapters } from '../pilot-mount-adapters'
import { vitestRecordingScheduler } from '../vitest-recording-scheduler'
import { operationMutation, type Mutation } from './operation-mutations'

const root = resolve(import.meta.dirname, '../../../../..')
const input = readScenarios(
  process.env.RPC_FOUNDATION_SCENARIOS ??
    resolve(root, 'mobile/rpc-foundation/pilot-scenarios.json')
)
const goldens = process.env.RPC_FOUNDATION_GOLDENS ?? resolve(root, 'mobile/rpc-foundation/goldens')

// Prove each probe closes a surviving mutation.
// Empty session inputs exercise omission guards that always-filled fixtures could not reach.
const HOLES: readonly { mutation: Mutation; operation: string; closedBy: readonly string[] }[] = [
  {
    mutation: 'new-tab-refusal-order',
    operation: 'settings.new-tab-agents',
    closedBy: ['probe-new-tab-both-refused']
  },
  {
    mutation: 'new-tab-deferred-settings-read',
    operation: 'settings.new-tab-agents',
    closedBy: ['probe-new-tab-null-sibling-refused']
  },
  {
    mutation: 'workspace-context-refusal-blanks',
    operation: 'settings.workspace-context',
    closedBy: ['settings-workspace-context-refuse-after-data']
  },
  {
    mutation: 'display-mode-unconditional-client',
    operation: 'session.terminal-display-mode',
    closedBy: ['session-terminal-display-mode-auto-without-device-token']
  },
  {
    mutation: 'display-mode-unmeasured-viewport',
    operation: 'session.terminal-display-mode',
    closedBy: ['session-terminal-display-mode-auto-without-viewport']
  },
  {
    mutation: 'startup-tab-load-rejects-sequence',
    operation: 'session.startup',
    closedBy: ['session-startup-refused-tab-load-still-loads-terminals']
  },
  {
    mutation: 'create-after-tab-id-null',
    operation: 'session.create-terminal',
    closedBy: ['session-create-terminal-without-active-tab']
  },
  {
    mutation: 'create-quick-command-keys',
    operation: 'session.create-terminal',
    closedBy: [
      'session-create-terminal-runs-a-quick-command',
      'session-create-terminal-launches-an-agent-quick-command'
    ]
  },
  {
    mutation: 'create-second-tap-in-flight',
    operation: 'session.create-terminal',
    closedBy: ['session-create-terminal-ignores-a-second-create-in-flight']
  }
]

const changedParams: Partial<
  Record<Mutation, (params: Record<string, unknown>) => Record<string, unknown>>
> = {
  'display-mode-unconditional-client': ({ terminal, mode, ...params }) => ({
    terminal,
    mode,
    client: { id: null, type: 'mobile' },
    ...params
  }),
  'display-mode-unmeasured-viewport': (params) => ({ ...params, viewport: null }),
  'create-after-tab-id-null': (params) => ({ ...params, afterTabId: null }),
  'create-quick-command-keys': (params) =>
    Object.fromEntries(
      Object.entries(params).map(([key, value]) => [
        key === 'command' ? 'agentPrompt' : key === 'agentPrompt' ? 'command' : key,
        value
      ])
    )
}

function isParams(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

async function rejectedParamsVerdict(
  scenario: RecordingScenario,
  mutation: Mutation,
  changed: (params: Record<string, unknown>) => Record<string, unknown>
): Promise<string> {
  const baseline = readGolden(goldens, scenario.id).recording
  const original = pilotMountAdapters(root, { device: scenario })
  const control = await runRecording(
    scenario,
    original.adapters[scenario.operation]!,
    vitestRecordingScheduler()
  )
  expect(control).toStrictEqual(baseline)

  const method =
    scenario.operation === 'session.terminal-display-mode'
      ? 'terminal.setDisplayMode'
      : 'session.tabs.createTerminal'
  const targets = scenario.steps.filter((step) => 'complete' in step)
  expect(targets).toHaveLength(1)
  const target = targets[0]
  if (!target || !('complete' in target)) {
    throw new Error('Missing original parameter-mutant completion')
  }
  expect(target.complete).toBe(`${method}#1`)
  if (!isParams(target.params)) {
    throw new Error('Missing original parameter-mutant input')
  }
  const actualParams = changed(target.params)
  const { adapters, assertMutationApplied } = pilotMountAdapters(root, {
    device: scenario,
    mutation: operationMutation(mutation)
  })
  const scheduler = vitestRecordingScheduler()
  const complete = ScriptedRpcTransport.prototype.complete
  const completions: string[] = []
  const actions: string[] = []
  const states: unknown[] = []
  let disposed = 0
  const observed: {
    stopped?: { error: unknown; owner: ScriptedRpcTransport; at: number }
  } = {}
  let outcome: { error: unknown } | undefined
  const spy = vi.spyOn(ScriptedRpcTransport.prototype, 'complete').mockImplementation(function (
    this: ScriptedRpcTransport,
    ...args: Parameters<ScriptedRpcTransport['complete']>
  ) {
    completions.push(args[0])
    try {
      return complete.apply(this, args)
    } catch (error) {
      observed.stopped = { error, owner: this, at: scheduler.elapsed() }
      throw error
    }
  })
  try {
    await runRecording(
      scenario,
      (context) => {
        const mounted = adapters[scenario.operation]!(context)
        return {
          action(...args) {
            actions.push(args[0])
            return mounted.action.apply(mounted, args)
          },
          state() {
            const state = mounted.state()
            states.push(captureValue(state))
            return state
          },
          dispose() {
            disposed += 1
            return mounted.dispose()
          }
        }
      },
      scheduler
    )
  } catch (error) {
    outcome = { error }
  } finally {
    spy.mockRestore()
  }
  if (!outcome) {
    throw new Error('Parameter mutant did not reach its required rejection')
  }
  if (!(outcome.error instanceof RecordingParamsMismatch)) {
    throw outcome.error
  }
  assertMutationApplied()
  const { stopped } = observed
  if (!stopped || stopped.error !== outcome.error) {
    throw outcome.error
  }
  const { owner } = stopped
  expect(owner.stoppedGuard?.error).toBe(outcome.error)
  const binding = owner.bindings.get(target.complete)
  if (!binding) {
    throw new Error('Missing original allocated mutant binding')
  }
  expect(outcome.error.request).toBe(target.complete)
  expect(outcome.error.method).toBe(method)
  expect(outcome.error.frameId).toBe(binding.id)
  expect(binding.id).toBe('frame-1')
  expect(binding.child.allocation?.id).toBe(binding.id)
  expect(binding.method).toBe(method)
  expect(binding.params).toBe(outcome.error.actual)
  expect(outcome.error.expected).toBe(target.params)
  expect(outcome.error.actual).toStrictEqual(actualParams)
  expect(binding.completed).toBe(false)
  expect(binding.child.completion).toBeUndefined()
  expect(owner.failureGuard(outcome.error)).toStrictEqual({
    origin: 'scripted-complete-params',
    requested: target.complete,
    resolved: target.complete,
    method,
    frameId: binding.id,
    expected: captureValue(target.params),
    actual: captureValue(actualParams),
    expectedOwnKeys: Object.keys(target.params),
    actualOwnKeys: Object.keys(actualParams),
    completed: false,
    replyIssued: false
  })
  expect(owner.payloads.map((payload) => payload.json)).toStrictEqual([
    JSON.stringify({ id: binding.id, deviceToken: DEVICE_TOKEN, method, params: actualParams })
  ])
  expect(completions).toStrictEqual([target.complete])
  const prefix = scenario.steps.slice(0, scenario.steps.indexOf(target))
  expect(actions).toStrictEqual(prefix.flatMap((step) => ('action' in step ? [step.action] : [])))
  expect(states).toStrictEqual([control.checkpoints[0]!.observation.state])
  expect(disposed).toBe(1)
  expect(owner.pendingRequests()).toBe(0)
  expect(owner.requests).toHaveLength(1)
  expect(owner.requests[0]!.settlement.status).toBe('rejected')
  expect(stopped.at).toBe(0)
  expect(scheduler.timerEvidence?.()).toMatchObject({
    residual: 0,
    stopAttempted: true,
    stopped: true,
    clockRestored: true,
    spiesRestored: true
  })
  return 'killed'
}

async function verdict(id: string, mutation: Mutation): Promise<string> {
  const scenario = materializeScenario(
    input.scenarios.find((candidate) => candidate.id === id)!,
    'native'
  )
  const changed = changedParams[mutation]
  if (changed) {
    return rejectedParamsVerdict(scenario, mutation, changed)
  }
  const { adapters, assertMutationApplied } = pilotMountAdapters(root, {
    device: scenario,
    mutation: operationMutation(mutation)
  })
  const result = await runRecordingMutant(
    scenario,
    adapters[scenario.operation],
    vitestRecordingScheduler(),
    readGolden(goldens, id).recording
  )
  assertMutationApplied()
  return result.verdict
}

describe('probe scenarios close holes the pre-probe recordings left open', () => {
  for (const hole of HOLES) {
    for (const id of hole.closedBy) {
      it(`${id} kills ${hole.mutation}`, async () => {
        expect(await verdict(id, hole.mutation)).toBe('killed')
      })
    }
  }
})
