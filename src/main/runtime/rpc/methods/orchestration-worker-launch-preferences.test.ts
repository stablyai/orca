import { describe, expect, it } from 'vitest'
import { getAgentSessionOptionCatalog } from '../../../../shared/agent-session-option-catalog'
import { ORCHESTRATION_WORKER_LAUNCH_PREFERENCES_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import {
  assertWorkerLaunchPreferencesCreateTerminal,
  assertWorkerLaunchPreferencesRuntimeSupported,
  createPendingWorkerLaunchReceipt,
  resolveFederatedWorkerLaunchReceipt,
  resolveWorkerLaunchPreferences
} from './orchestration-worker-launch-preferences'
import { WorkerStartParams } from './orchestration-worker-start-schema'

describe('orchestration worker launch preferences', () => {
  it('passes an opaque Claude model and portable effort through the shared catalog', () => {
    expect(
      resolveWorkerLaunchPreferences({
        agent: 'claude',
        model: 'aws-bedrock-opus-5',
        effort: 'high'
      })
    ).toEqual({
      preferences: { model: 'aws-bedrock-opus-5', effort: 'high' },
      receipt: {
        requested: { agent: 'claude', model: 'aws-bedrock-opus-5', effort: 'high' },
        effective: { agent: 'claude', model: 'aws-bedrock-opus-5', effort: 'high' }
      }
    })
  })

  it('does not invent an effort when only a model is requested', () => {
    expect(
      resolveWorkerLaunchPreferences({ agent: 'codex', model: 'gpt-5.6-sol' }).preferences
    ).toEqual({ model: 'gpt-5.6-sol' })
  })

  it.each([
    {
      model: 'gpt-5.6-sol',
      accepted: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
      rejected: ['future-effort']
    },
    {
      model: 'gpt-5.6-terra',
      accepted: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
      rejected: ['future-effort']
    },
    {
      model: 'gpt-5.6-luna',
      accepted: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
      rejected: ['ultra', 'future-effort']
    },
    {
      model: 'gpt-5.5',
      accepted: ['minimal', 'low', 'medium', 'high', 'xhigh'],
      rejected: ['max', 'ultra', 'future-effort']
    },
    {
      model: 'gpt-5.2-codex',
      accepted: ['minimal', 'low', 'medium', 'high', 'xhigh'],
      rejected: ['max', 'ultra', 'future-effort']
    },
    {
      model: 'gpt-5.4',
      accepted: ['minimal', 'low', 'medium', 'high', 'xhigh'],
      rejected: ['max', 'ultra', 'future-effort']
    },
    {
      model: 'gpt-5.4-mini',
      accepted: ['minimal', 'low', 'medium', 'high', 'xhigh'],
      rejected: ['max', 'ultra', 'future-effort']
    },
    {
      model: 'gpt-5.3-codex-spark',
      accepted: ['minimal', 'low', 'medium', 'high', 'xhigh'],
      rejected: ['max', 'ultra', 'future-effort']
    },
    {
      model: 'future-codex-model',
      accepted: ['minimal', 'low', 'medium', 'high', 'xhigh'],
      rejected: ['max', 'ultra', 'future-effort']
    }
  ])('enforces the Codex effort ceiling for $model', ({ model, accepted, rejected }) => {
    const catalog = getAgentSessionOptionCatalog('codex')!
    const effort =
      catalog.models
        .find((candidate) => candidate.id === model)
        ?.options.find((option) => option.id === 'effort') ??
      catalog.unknownModelOptions?.find((option) => option.id === 'effort')

    expect(effort?.kind.type).toBe('select')
    expect(
      effort?.kind.type === 'select' ? effort.kind.choices.map(({ value }) => value) : []
    ).toEqual(accepted)

    for (const effortValue of accepted) {
      expect(
        resolveWorkerLaunchPreferences({ agent: 'codex', model, effort: effortValue }).preferences
      ).toEqual({ model, effort: effortValue })
    }
    for (const effortValue of rejected) {
      expect(() =>
        resolveWorkerLaunchPreferences({ agent: 'codex', model, effort: effortValue })
      ).toThrow(`does not support effort ${effortValue}`)
    }
  })

  it('rejects effort without a model', () => {
    expect(() => resolveWorkerLaunchPreferences({ agent: 'codex', effort: 'high' })).toThrow(
      '--effort requires --model'
    )
  })

  it('rejects model selection for agents without a launch catalog', () => {
    expect(() =>
      resolveWorkerLaunchPreferences({ agent: 'grok', model: 'grok-code-fast-1' })
    ).toThrow('does not support launch-time model selection')
  })

  it('does not expose deprecated Gemini model selection to worker-start', () => {
    expect(() =>
      resolveWorkerLaunchPreferences({ agent: 'gemini', model: 'gemini-3-pro-preview' })
    ).toThrow('does not support launch-time model selection')
  })

  it('rejects preferences when reusing an existing terminal', () => {
    expect(() =>
      assertWorkerLaunchPreferencesCreateTerminal({
        terminal: 'term_existing',
        model: 'gpt-5.6-sol'
      })
    ).toThrow('cannot be applied when reusing an existing terminal')
  })

  it('requires remote capability support only for explicit preferences', () => {
    expect(() =>
      assertWorkerLaunchPreferencesRuntimeSupported({
        model: 'gpt-5.6-sol',
        capabilities: [],
        serverName: 'windows'
      })
    ).toThrow('does not support worker model or effort overrides')
    expect(() =>
      assertWorkerLaunchPreferencesRuntimeSupported({
        capabilities: [],
        serverName: 'windows'
      })
    ).not.toThrow()
    expect(() =>
      assertWorkerLaunchPreferencesRuntimeSupported({
        model: 'gpt-5.6-sol',
        capabilities: [ORCHESTRATION_WORKER_LAUNCH_PREFERENCES_RUNTIME_CAPABILITY],
        serverName: 'windows'
      })
    ).not.toThrow()
  })

  it('uses the requested launch receipt when an older worker omits it', () => {
    const requested = createPendingWorkerLaunchReceipt({
      agent: 'codex',
      model: 'gpt-5.6-sol',
      effort: 'high'
    })

    expect(resolveFederatedWorkerLaunchReceipt(undefined, requested, true)).toEqual({
      requested: requested.requested,
      effective: requested.requested
    })
    expect(resolveFederatedWorkerLaunchReceipt(undefined, requested, false)).toBe(requested)
  })

  it.each([' custom-model', 'custom-model '])(
    'rejects model ids with surrounding whitespace: %j',
    (model) => {
      expect(WorkerStartParams.safeParse({ task: 'task_1', agent: 'codex', model }).success).toBe(
        false
      )
    }
  )

  it('bounds opaque launch preferences', () => {
    expect(
      WorkerStartParams.safeParse({
        task: 'task_1',
        agent: 'codex',
        model: 'm'.repeat(513)
      }).success
    ).toBe(false)
    expect(
      WorkerStartParams.safeParse({
        task: 'task_1',
        agent: 'codex',
        model: 'custom-model',
        effort: 'e'.repeat(513)
      }).success
    ).toBe(false)
  })
})
