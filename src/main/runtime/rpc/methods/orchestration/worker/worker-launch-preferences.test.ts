import { describe, expect, it } from 'vitest'
import { getAgentSessionOptionCatalog } from '../../../../../../shared/agent-session-option-catalog'
import { resolveAgentSessionOptionLaunch } from '../../../../../../shared/agent-session-option-launch'
import { ORCHESTRATION_WORKER_LAUNCH_PREFERENCES_RUNTIME_CAPABILITY } from '../../../../../../shared/protocol-version'
import {
  assertWorkerLaunchPreferencesCreateTerminal,
  assertWorkerLaunchPreferencesRuntimeSupported,
  createPendingWorkerLaunchReceipt,
  resolveFederatedWorkerLaunchReceipt,
  resolveWorkerLaunchPreferences
} from './worker-launch-preferences'
import { WorkerStartParams } from './worker-start-schema'

describe('orchestration worker launch preferences', () => {
  it('passes a discovered OMP model through the existing launch arguments and receipt', () => {
    const model = 'google-vertex/claude-haiku-4-5@20251001'
    const launch = resolveWorkerLaunchPreferences({ agent: 'omp', model })

    expect(launch).toEqual({
      preferences: { model },
      receipt: {
        requested: { agent: 'omp', model, effort: null },
        effective: { agent: 'omp', model, effort: null }
      }
    })
    expect(resolveAgentSessionOptionLaunch('omp', launch.preferences, [], false)).toEqual({
      args: ['--model', model],
      appliedValues: { model }
    })
  })

  it('keeps OMP configuration defaults when no model is requested', () => {
    expect(resolveWorkerLaunchPreferences({ agent: 'omp' })).toEqual({
      preferences: undefined,
      receipt: {
        requested: { agent: 'omp', model: null, effort: null },
        effective: { agent: 'omp', model: null, effort: null }
      }
    })
  })

  it('rejects OMP effort until its model options support it', () => {
    expect(() =>
      resolveWorkerLaunchPreferences({
        agent: 'omp',
        model: 'google-vertex/claude-haiku-4-5@20251001',
        effort: 'low'
      })
    ).toThrow('does not support effort low')
  })

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

  it('passes an account-scoped Antigravity model and supported effort through the shared catalog', () => {
    expect(
      resolveWorkerLaunchPreferences({
        agent: 'antigravity',
        model: 'gemini-3.1-pro-high',
        effort: 'high'
      })
    ).toEqual({
      preferences: { model: 'gemini-3.1-pro-high', effort: 'high' },
      receipt: {
        requested: {
          agent: 'antigravity',
          model: 'gemini-3.1-pro-high',
          effort: 'high'
        },
        effective: {
          agent: 'antigravity',
          model: 'gemini-3.1-pro-high',
          effort: 'high'
        }
      }
    })
  })

  it('rejects unsupported Antigravity effort values', () => {
    expect(() =>
      resolveWorkerLaunchPreferences({
        agent: 'antigravity',
        model: 'gemini-3.1-pro-high',
        effort: 'xhigh'
      })
    ).toThrow('does not support effort xhigh')
  })

  it('passes a Muse model and reasoning effort through the shared catalog', () => {
    expect(
      resolveWorkerLaunchPreferences({ agent: 'muse', model: 'muse-spark-1.3', effort: 'xhigh' })
    ).toEqual({
      preferences: { model: 'muse-spark-1.3', effort: 'xhigh' },
      receipt: {
        requested: { agent: 'muse', model: 'muse-spark-1.3', effort: 'xhigh' },
        effective: { agent: 'muse', model: 'muse-spark-1.3', effort: 'xhigh' }
      }
    })
  })

  it('rejects Muse effort values outside its reasoning ladder', () => {
    expect(() =>
      resolveWorkerLaunchPreferences({ agent: 'muse', model: 'muse-spark-1.3', effort: 'turbo' })
    ).toThrow('does not support effort turbo')
  })

  it('refuses an opencode model until the execution host verifies legacy TUI support', () => {
    expect(() =>
      resolveWorkerLaunchPreferences({ agent: 'opencode', model: 'meta/muse-spark-1.3' })
    ).toThrow('cannot verify launch-time model selection')
  })

  it('explains the existing-worktree requirement even if a new-worktree host is verified', () => {
    expect(() =>
      resolveWorkerLaunchPreferences({
        agent: 'opencode',
        model: 'opencode/fledge-alpha-free',
        createsWorktree: true,
        openCodeModelLaunchSupported: true
      })
    ).toThrow('requires an existing worktree')
  })

  it('supports an opaque OpenCode model on a verified legacy host', () => {
    expect(
      resolveWorkerLaunchPreferences({
        agent: 'opencode',
        model: 'zai-coding-plan/glm-5.3-flash',
        openCodeModelLaunchSupported: true
      })
    ).toEqual({
      preferences: { model: 'zai-coding-plan/glm-5.3-flash' },
      receipt: {
        requested: { agent: 'opencode', model: 'zai-coding-plan/glm-5.3-flash', effort: null },
        effective: { agent: 'opencode', model: 'zai-coding-plan/glm-5.3-flash', effort: null }
      }
    })
  })

  it('refuses an unverified OpenCode effort on a legacy host', () => {
    expect(() =>
      resolveWorkerLaunchPreferences({
        agent: 'opencode',
        model: 'opencode/fledge-alpha-free',
        effort: 'high',
        openCodeModelLaunchSupported: true
      })
    ).toThrow('does not support effort high')
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
      accepted: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
      rejected: ['future-effort']
    },
    {
      model: 'gpt-5.4-mini',
      accepted: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
      rejected: ['future-effort']
    },
    {
      model: 'gpt-5.3-codex-spark',
      accepted: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
      rejected: ['future-effort']
    },
    {
      model: 'gpt-6.1-sol',
      accepted: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
      rejected: ['turbo', 'future-effort']
    },
    {
      model: 'future-codex-model',
      accepted: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
      rejected: ['future-effort']
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

  describe('with efforts discovered from the host Codex', () => {
    const solEfforts = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']

    it.each(['max', 'ultra'])('accepts %s for gpt-6.1-sol when Codex lists it', (effort) => {
      expect(
        resolveWorkerLaunchPreferences({
          agent: 'codex',
          model: 'gpt-6.1-sol',
          effort,
          discoveredEfforts: solEfforts
        }).preferences
      ).toEqual({ model: 'gpt-6.1-sol', effort })
    })

    it.each([
      ['an effort Codex does not list for the model', 'gpt-6-luna', 'ultra'],
      ['minimal, which the static fallback alone would allow', 'gpt-6.1-sol', 'minimal'],
      ['an unknown effort name', 'gpt-6.1-sol', 'turbo']
    ])('refuses %s', (_case, model, effort) => {
      const discoveredEfforts =
        model === 'gpt-6-luna' ? ['low', 'medium', 'high', 'xhigh', 'max'] : solEfforts
      expect(() =>
        resolveWorkerLaunchPreferences({ agent: 'codex', model, effort, discoveredEfforts })
      ).toThrow(
        `does not support effort ${effort}. The installed codex lists: ${discoveredEfforts.join(', ')}.`
      )
    })

    it('lets the host listing raise a stale static ceiling for a known model', () => {
      expect(() =>
        resolveWorkerLaunchPreferences({ agent: 'codex', model: 'gpt-5.5', effort: 'max' })
      ).toThrow('does not support effort max')
      expect(
        resolveWorkerLaunchPreferences({
          agent: 'codex',
          model: 'gpt-5.5',
          effort: 'max',
          discoveredEfforts: ['low', 'medium', 'high', 'xhigh', 'max']
        }).preferences
      ).toEqual({ model: 'gpt-5.5', effort: 'max' })
    })

    it.each([null, []])('uses the static catalog when discovery has no answer (%j)', (none) => {
      expect(() =>
        resolveWorkerLaunchPreferences({
          agent: 'codex',
          model: 'gpt-5.5',
          effort: 'max',
          discoveredEfforts: none
        })
      ).toThrow('does not support effort max')
    })
  })

  it.each(['codex', 'omp'] as const)('rejects %s effort without a model', (agent) => {
    expect(() => resolveWorkerLaunchPreferences({ agent, effort: 'high' })).toThrow(
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
