import { describe, expect, it } from 'vitest'
import { ORCHESTRATION_WORKER_LAUNCH_PREFERENCES_RUNTIME_CAPABILITY } from '../../../../../../shared/protocol-version'
import { SEED_WORKER_LAUNCH_MODEL_AUTHORITY } from './worker-launch-model-authority'
import {
  assertWorkerLaunchPreferencesCreateTerminal,
  assertWorkerLaunchPreferencesRuntimeSupported,
  createPendingWorkerLaunchReceipt,
  resolveFederatedWorkerLaunchReceipt,
  resolveWorkerLaunchPreferences
} from './worker-launch-preferences'
import { WorkerStartParams } from './worker-start-schema'

const CODEX_ULTRA_LEVELS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']
const CODEX_XHIGH_LEVELS = ['minimal', 'low', 'medium', 'high', 'xhigh']

describe('orchestration worker launch preferences', () => {
  it('passes an official Claude model and portable effort through the shared catalog', () => {
    expect(
      resolveWorkerLaunchPreferences({
        agent: 'claude',
        model: 'opus',
        effort: 'high'
      })
    ).toEqual({
      preferences: { model: 'opus', effort: 'high' },
      receipt: {
        requested: { agent: 'claude', model: 'opus', effort: 'high' },
        effective: { agent: 'claude', model: 'opus', effort: 'high' }
      }
    })
  })

  it('accepts an id only the live CLI list carries, and refuses one it has dropped', () => {
    const authority = { source: 'live' as const, modelIds: ['opus[1m]'] }

    expect(
      resolveWorkerLaunchPreferences({
        agent: 'claude',
        model: 'opus[1m]',
        effort: 'max',
        authority
      }).preferences
    ).toEqual({ model: 'opus[1m]', effort: 'max' })
    // The live list is the whole membership: a seed id the CLI no longer lists is gone.
    expect(() =>
      resolveWorkerLaunchPreferences({ agent: 'claude', model: 'sonnet', authority })
    ).toThrow(
      'Agent claude does not accept model sonnet. Accepted ids (listed by the claude CLI on the executing host): opus[1m].'
    )
  })

  it('accepts an unlisted id when the host could not be listed', () => {
    // A probe that could not run is not a statement that the model does not exist. `opus[1m]` is
    // the id `worker-start --model` documents, and it is absent from the short Claude seed.
    expect(
      resolveWorkerLaunchPreferences({
        agent: 'claude',
        model: 'opus[1m]',
        effort: 'max',
        authority: SEED_WORKER_LAUNCH_MODEL_AUTHORITY
      }).preferences
    ).toEqual({ model: 'opus[1m]', effort: 'max' })
  })

  it('keeps a seeded model’s own effort menu when the probe advertises fewer levels', () => {
    // The Codex probe reports one generic level list for every model; narrowing to it would
    // refuse `ultra` on a warm cache and accept it on a cold one.
    const authority = { source: 'live' as const, modelIds: ['gpt-5.6-sol'] }

    expect(
      resolveWorkerLaunchPreferences({
        agent: 'codex',
        model: 'gpt-5.6-sol',
        effort: 'ultra',
        authority
      }).preferences
    ).toEqual({ model: 'gpt-5.6-sol', effort: 'ultra' })
    expect(() =>
      resolveWorkerLaunchPreferences({
        agent: 'codex',
        model: 'gpt-5.6-sol',
        effort: 'not-a-level',
        authority
      })
    ).toThrow('Agent codex model gpt-5.6-sol does not support effort not-a-level.')
  })

  it('accepts a seed id when the host could not be listed', () => {
    expect(
      resolveWorkerLaunchPreferences({
        agent: 'codex',
        model: 'gpt-5.5',
        effort: 'xhigh',
        authority: SEED_WORKER_LAUNCH_MODEL_AUTHORITY
      }).preferences
    ).toEqual({ model: 'gpt-5.5', effort: 'xhigh' })
  })

  it('does not invent an effort when only a model is requested', () => {
    expect(
      resolveWorkerLaunchPreferences({ agent: 'codex', model: 'gpt-5.6-sol' }).preferences
    ).toEqual({ model: 'gpt-5.6-sol' })
  })

  it.each([
    { model: 'gpt-5.6-sol', accepted: CODEX_ULTRA_LEVELS, rejected: ['future-effort'] },
    { model: 'gpt-5.6-terra', accepted: CODEX_ULTRA_LEVELS, rejected: ['future-effort'] },
    {
      model: 'gpt-5.6-luna',
      accepted: CODEX_ULTRA_LEVELS.slice(0, -1),
      rejected: ['ultra', 'future-effort']
    },
    {
      model: 'gpt-5.5',
      accepted: CODEX_XHIGH_LEVELS,
      rejected: ['max', 'ultra', 'future-effort']
    },
    {
      model: 'gpt-5.2-codex',
      accepted: CODEX_XHIGH_LEVELS,
      rejected: ['max', 'ultra', 'future-effort']
    }
  ])('enforces the Codex effort ceiling for $model', ({ model, accepted, rejected }) => {
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

  it.each(['gpt-5.4', 'gpt-5.4-mini', 'gpt-5.3-codex-spark', 'future-codex-model'])(
    'refuses an unlisted Codex id only once the host has answered: %s',
    (model) => {
      expect(resolveWorkerLaunchPreferences({ agent: 'codex', model }).preferences).toEqual({
        model
      })
      expect(() =>
        resolveWorkerLaunchPreferences({
          agent: 'codex',
          model,
          authority: { source: 'live', modelIds: ['gpt-5.6-sol'] }
        })
      ).toThrow(`Agent codex does not accept model ${model}.`)
    }
  )

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

  it('refuses --retry-of beside --spec, which could only create a fresh Task', () => {
    const parsed = WorkerStartParams.safeParse({
      spec: 'redo it',
      retryOf: 'ctx_prior',
      agent: 'claude',
      from: 'term_coord'
    })
    expect(parsed.success).toBe(false)
    expect(parsed.error?.issues.map((issue) => issue.message)).toContain(
      '--retry-of needs --task <task_id> naming the failed Task; --spec creates a new one'
    )
    expect(
      WorkerStartParams.safeParse({
        task: 'task_1',
        retryOf: 'ctx_prior',
        agent: 'claude',
        from: 'term_coord'
      }).success
    ).toBe(true)
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

  it('requires exactly one task identity', () => {
    expect(WorkerStartParams.safeParse({ agent: 'codex' }).success).toBe(false)
    expect(
      WorkerStartParams.safeParse({ task: 'task_1', spec: 'new work', agent: 'codex' }).success
    ).toBe(false)
    expect(
      WorkerStartParams.safeParse({ spec: 'new work', agent: 'codex', from: 'term_coord' }).success
    ).toBe(true)
  })
})
