import { describe, expect, it } from 'vitest'
import { ORCHESTRATION_WORKER_LAUNCH_PREFERENCES_RUNTIME_CAPABILITY } from '../../../../../../shared/orchestration/orchestration-runtime-capabilities'
import {
  resolveFederatedWorkerLaunchParams,
  resolveOrchestrationWorkerLaunchDefaults
} from './worker-launch-preferences'
import { WorkerStartParams } from '../../../../../../shared/rpc-contract/orchestration-worker-start-params'

describe('orchestration worker launch defaults', () => {
  it.each([
    {
      label: 'agent',
      defaults: { agent: 'codex' as const, models: {}, efforts: { codex: 'max' } },
      expected: {
        agent: 'codex' as const,
        model: undefined,
        effort: undefined,
        applied: { agent: true, model: false, effort: false }
      }
    },
    {
      label: 'agent and model',
      defaults: {
        agent: 'codex' as const,
        models: { codex: 'gpt-5.6-sol' },
        efforts: {}
      },
      expected: {
        agent: 'codex',
        model: 'gpt-5.6-sol',
        effort: undefined,
        applied: { agent: true, model: true, effort: false }
      }
    }
  ])('applies the $label default without inventing an effort', ({ defaults, expected }) => {
    expect(resolveOrchestrationWorkerLaunchDefaults({ defaults })).toEqual(expected)
  })

  it('preserves explicit launch fields over stored defaults', () => {
    expect(
      resolveOrchestrationWorkerLaunchDefaults({
        agent: 'claude',
        model: 'aws-bedrock-opus-5',
        effort: 'high',
        defaults: {
          agent: 'codex',
          models: { claude: 'other-model' },
          efforts: { claude: 'low' }
        }
      })
    ).toEqual({
      agent: 'claude',
      model: 'aws-bedrock-opus-5',
      effort: 'high',
      applied: { agent: false, model: false, effort: false }
    })
  })

  it('applies stored defaults only for omitted launch fields', () => {
    expect(
      resolveOrchestrationWorkerLaunchDefaults({
        agent: undefined,
        model: 'gpt-5.6-luna',
        effort: undefined,
        defaults: {
          agent: 'codex',
          models: { codex: 'gpt-5.6-sol' },
          efforts: { codex: 'max' }
        }
      })
    ).toEqual({
      agent: 'codex',
      model: 'gpt-5.6-luna',
      effort: 'max',
      applied: { agent: true, model: false, effort: true }
    })
  })

  it('drops a stored effort that does not fit an explicit model', () => {
    expect(
      resolveOrchestrationWorkerLaunchDefaults({
        agent: 'codex',
        model: 'gpt-5.5',
        effort: undefined,
        defaults: {
          agent: 'codex',
          models: { codex: 'gpt-5.6-sol' },
          efforts: { codex: 'max' }
        }
      })
    ).toEqual({
      agent: 'codex',
      model: 'gpt-5.5',
      effort: undefined,
      applied: { agent: false, model: false, effort: false }
    })
  })

  it('does not inject model preferences for an agent without launch support', () => {
    expect(
      resolveOrchestrationWorkerLaunchDefaults({
        defaults: {
          agent: 'gemini',
          models: { gemini: 'gemini-3-pro-preview' },
          efforts: { gemini: 'high' }
        }
      })
    ).toEqual({
      agent: 'gemini',
      model: undefined,
      effort: undefined,
      applied: { agent: true, model: false, effort: false }
    })
  })

  it('does not apply stored defaults when reusing a terminal', () => {
    expect(
      resolveOrchestrationWorkerLaunchDefaults({
        terminal: 'term_existing',
        defaults: {
          agent: 'codex',
          models: { codex: 'gpt-5.6-sol' },
          efforts: { codex: 'high' }
        }
      })
    ).toEqual({
      agent: undefined,
      model: undefined,
      effort: undefined,
      applied: { agent: false, model: false, effort: false }
    })
  })

  it('drops injected preferences when a federated server lacks support', () => {
    const params = WorkerStartParams.parse({
      task: 'task_1',
      from: 'term_coord',
      on: 'windows',
      worktree: 'new-top-level',
      agent: 'codex',
      model: 'gpt-5.6-sol',
      effort: 'high'
    })

    const resolved = resolveFederatedWorkerLaunchParams({
      params,
      capabilities: [],
      defaultsApplied: { agent: true, model: true, effort: true }
    })
    expect(resolved).toMatchObject({ agent: 'codex' })
    expect(resolved).not.toHaveProperty('model')
    expect(resolved).not.toHaveProperty('effort')
  })

  it('preserves explicit federated preferences when defaults were not applied', () => {
    const params = WorkerStartParams.parse({
      task: 'task_1',
      from: 'term_coord',
      on: 'windows',
      worktree: 'new-top-level',
      agent: 'codex',
      model: 'gpt-5.5',
      effort: 'high'
    })

    expect(
      resolveFederatedWorkerLaunchParams({
        params,
        capabilities: [],
        defaultsApplied: { agent: false, model: false, effort: false }
      })
    ).toBe(params)
    expect(
      resolveFederatedWorkerLaunchParams({
        params,
        capabilities: [ORCHESTRATION_WORKER_LAUNCH_PREFERENCES_RUNTIME_CAPABILITY],
        defaultsApplied: { agent: true, model: true, effort: true }
      })
    ).toBe(params)
  })
})
