import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getAgentSessionOptionCatalog } from '../../../../../../shared/agent-session-option-catalog'
import type { CommitMessageModelCapability } from '../../../../../../shared/commit-message-agent-spec'
import {
  clearWorkerLaunchModelAuthorityCacheForTests,
  describeWorkerLaunchModelRejection,
  resolveWorkerLaunchModelAuthority,
  SEED_WORKER_LAUNCH_MODEL_AUTHORITY,
  type WorkerLaunchModelAuthority,
  type WorkerLaunchModelDiscoveryRuntime
} from './worker-launch-model-authority'
import { resolveWorkerLaunchPreferences } from './worker-launch-preferences'

const CLAUDE_CATALOG = getAgentSessionOptionCatalog('claude')!
const CODEX_CATALOG = getAgentSessionOptionCatalog('codex')!
const GROK_CATALOG = getAgentSessionOptionCatalog('grok')!

function liveModel(id: string, effortLevels: readonly string[] = []): CommitMessageModelCapability {
  return {
    id,
    label: id,
    ...(effortLevels.length > 0
      ? { thinkingLevels: effortLevels.map((level) => ({ id: level, label: level })) }
      : {})
  }
}

function probeRuntime(
  respond: (worktreeSelector: string) => unknown,
  hostKeyFor: (worktreeSelector: string) => string = () => 'local'
): {
  runtime: WorkerLaunchModelDiscoveryRuntime
  discover: ReturnType<typeof vi.fn>
  resolveHostKey: ReturnType<typeof vi.fn>
} {
  const discover = vi.fn(async (worktreeSelector: string) => await respond(worktreeSelector))
  const resolveHostKey = vi.fn(async (worktreeSelector: string) => hostKeyFor(worktreeSelector))
  return {
    runtime: {
      discoverRuntimeCommitMessageModels: discover,
      resolveRuntimeCommitMessageDiscoveryHostKey: resolveHostKey
    } as never,
    discover,
    resolveHostKey
  }
}

function probeSuccess(models: readonly CommitMessageModelCapability[]): unknown {
  return {
    success: true,
    catalogOrigin: 'probe',
    models,
    defaultModelId: models[0]?.id ?? '',
    capability: {
      id: 'claude',
      label: 'Claude',
      modelSource: 'dynamic',
      models,
      defaultModelId: ''
    }
  }
}

describe('worker launch model authority', () => {
  beforeEach(() => {
    clearWorkerLaunchModelAuthorityCacheForTests()
  })

  it('takes the live Claude CLI list as the whole membership, dropping seed ids it omits', async () => {
    const { runtime } = probeRuntime(() =>
      probeSuccess([liveModel('opus[1m]', ['low', 'high', 'max']), liveModel('haiku')])
    )

    const authority = await resolveWorkerLaunchModelAuthority({
      catalog: CLAUDE_CATALOG,
      agent: 'claude',
      runtime,
      worktreeSelector: 'id:wt_local'
    })

    expect(authority).toEqual({ source: 'live', modelIds: ['opus[1m]', 'haiku'] })
  })

  it('never asks an agent whose probe only extends the seed, and so refuses nothing', async () => {
    const { runtime, discover, resolveHostKey } = probeRuntime(() =>
      probeSuccess([liveModel('gpt-5.7-preview')])
    )

    const authority = await resolveWorkerLaunchModelAuthority({
      catalog: CODEX_CATALOG,
      agent: 'codex',
      runtime,
      worktreeSelector: 'id:wt_local'
    })

    // The Codex seed is deliberately short, so a list that merges into it is not a complete one.
    expect(authority).toEqual(SEED_WORKER_LAUNCH_MODEL_AUTHORITY)
    expect(discover).not.toHaveBeenCalled()
    expect(resolveHostKey).not.toHaveBeenCalled()
  })

  it('refuses an unlisted id for the agent whose list replaces the seed, and not for the one that extends it', async () => {
    const { runtime } = probeRuntime(() => probeSuccess([liveModel('opus[1m]')]))
    const claude = await resolveWorkerLaunchModelAuthority({
      catalog: CLAUDE_CATALOG,
      agent: 'claude',
      runtime,
      worktreeSelector: 'id:wt_local'
    })
    const codex = await resolveWorkerLaunchModelAuthority({
      catalog: CODEX_CATALOG,
      agent: 'codex',
      runtime,
      worktreeSelector: 'id:wt_local'
    })

    // The point of the PR: a resolved Claude id the CLI never offers stays refused.
    expect(() =>
      resolveWorkerLaunchPreferences({ agent: 'claude', model: 'claude-opus-5', authority: claude })
    ).toThrow('Agent claude does not accept model claude-opus-5')
    // And an id only the account knows about reaches the launch rather than being second-guessed.
    expect(
      resolveWorkerLaunchPreferences({
        agent: 'codex',
        model: 'gpt-account-only',
        authority: codex
      }).preferences
    ).toEqual({ model: 'gpt-account-only' })
  })

  it.each([
    { label: 'the probe throws', respond: () => Promise.reject(new Error('ssh down')) },
    { label: 'the probe fails', respond: () => ({ success: false, error: 'no CLI' }) },
    {
      label: 'the probe falls back to Orca’s own list',
      respond: () => ({ ...(probeSuccess([liveModel('opus')]) as object), catalogOrigin: 'spec' })
    },
    { label: 'the probe returns nothing', respond: () => probeSuccess([]) }
  ])('falls back to the seed when $label', async ({ respond }) => {
    const { runtime } = probeRuntime(respond as () => unknown)

    const authority = await resolveWorkerLaunchModelAuthority({
      catalog: CLAUDE_CATALOG,
      agent: 'claude',
      runtime,
      worktreeSelector: 'id:wt_local'
    })

    expect(authority).toEqual(SEED_WORKER_LAUNCH_MODEL_AUTHORITY)
  })

  it('seeds without probing when no worktree names the executing host yet', async () => {
    const { runtime, discover } = probeRuntime(() => probeSuccess([liveModel('opus[1m]')]))

    const authority = await resolveWorkerLaunchModelAuthority({
      catalog: CLAUDE_CATALOG,
      agent: 'claude',
      runtime,
      worktreeSelector: null
    })

    expect(authority.source).toBe('seed')
    expect(discover).not.toHaveBeenCalled()
  })

  it('seeds without probing when the selector names no host this client can resolve', async () => {
    const { runtime, discover } = probeRuntime(
      () => probeSuccess([liveModel('opus[1m]')]),
      () => {
        throw new Error('worktree_not_found')
      }
    )

    const authority = await resolveWorkerLaunchModelAuthority({
      catalog: CLAUDE_CATALOG,
      agent: 'claude',
      runtime,
      worktreeSelector: 'id:wt_folder_workspace'
    })

    expect(authority.source).toBe('seed')
    expect(discover).not.toHaveBeenCalled()
  })

  it('reports a runtime that cannot answer at all, which would silence --model for good', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const { discover } = probeRuntime(() => probeSuccess([liveModel('opus[1m]')]))
      // A runtime missing the method is a wiring failure, not an unresolvable worktree.
      const unwired = { discoverRuntimeCommitMessageModels: discover } as never

      const authority = await resolveWorkerLaunchModelAuthority({
        catalog: CLAUDE_CATALOG,
        agent: 'claude',
        runtime: unwired,
        worktreeSelector: 'id:wt_local'
      })

      expect(authority.source).toBe('seed')
      expect(consoleError).toHaveBeenCalledWith(
        '[worker-launch] no discovery host key; --model cannot be checked:',
        expect.any(TypeError)
      )
      // An unresolvable selector is ordinary and must stay silent.
      consoleError.mockClear()
      const { runtime: resolvable } = probeRuntime(
        () => probeSuccess([liveModel('opus[1m]')]),
        () => {
          throw new Error('selector_not_found')
        }
      )
      await resolveWorkerLaunchModelAuthority({
        catalog: CLAUDE_CATALOG,
        agent: 'claude',
        runtime: resolvable,
        worktreeSelector: 'id:wt_missing'
      })
      expect(consoleError).not.toHaveBeenCalled()
    } finally {
      consoleError.mockRestore()
    }
  })

  it('does not cache a failure, so the next dispatch retries the host', async () => {
    let attempt = 0
    const { runtime, discover } = probeRuntime(() => {
      attempt += 1
      return attempt === 1 ? { success: false, error: 'no CLI' } : probeSuccess([liveModel('opus')])
    })
    const args = {
      catalog: CLAUDE_CATALOG,
      agent: 'claude' as const,
      runtime,
      worktreeSelector: 'id:wt_local'
    }

    expect((await resolveWorkerLaunchModelAuthority(args)).source).toBe('seed')
    expect((await resolveWorkerLaunchModelAuthority(args)).source).toBe('live')
    expect(discover).toHaveBeenCalledTimes(2)
  })

  it('probes one host once for every worktree that runs on it', async () => {
    const { runtime, discover } = probeRuntime(
      () => probeSuccess([liveModel('opus[1m]')]),
      () => 'local'
    )

    await resolveWorkerLaunchModelAuthority({
      catalog: CLAUDE_CATALOG,
      agent: 'claude',
      runtime,
      worktreeSelector: 'id:wt_one'
    })
    const second = await resolveWorkerLaunchModelAuthority({
      catalog: CLAUDE_CATALOG,
      agent: 'claude',
      runtime,
      worktreeSelector: 'id:wt_two'
    })

    expect(discover).toHaveBeenCalledTimes(1)
    expect(second.modelIds).toEqual(['opus[1m]'])
  })

  it('reuses one host answer instead of probing on every dispatch', async () => {
    const { runtime, discover } = probeRuntime(() => probeSuccess([liveModel('opus[1m]')]))
    const args = {
      catalog: CLAUDE_CATALOG,
      agent: 'claude' as const,
      runtime,
      worktreeSelector: 'id:wt_local'
    }

    await resolveWorkerLaunchModelAuthority(args)
    const second = await resolveWorkerLaunchModelAuthority(args)

    expect(discover).toHaveBeenCalledTimes(1)
    expect(second.modelIds).toEqual(['opus[1m]'])
  })

  it('shares one in-flight probe across dispatches that race it', async () => {
    let release: (() => void) | undefined
    const started = new Promise<void>((resolve) => {
      release = resolve
    })
    const { runtime, discover } = probeRuntime(async () => {
      await started
      return probeSuccess([liveModel('opus[1m]')])
    })
    const args = {
      catalog: CLAUDE_CATALOG,
      agent: 'claude' as const,
      runtime,
      worktreeSelector: 'id:wt_local'
    }

    const both = Promise.all([
      resolveWorkerLaunchModelAuthority(args),
      resolveWorkerLaunchModelAuthority(args)
    ])
    release!()
    const [first, second] = await both

    expect(discover).toHaveBeenCalledTimes(1)
    expect(first.modelIds).toEqual(['opus[1m]'])
    expect(second.modelIds).toEqual(['opus[1m]'])
  })

  it('answers with the seed past the dispatch budget, leaving the probe to fill the cache', async () => {
    vi.useFakeTimers()
    try {
      let release: (() => void) | undefined
      const slow = new Promise<void>((resolve) => {
        release = resolve
      })
      const { runtime, discover } = probeRuntime(async () => {
        await slow
        return probeSuccess([liveModel('opus[1m]')])
      })
      const args = {
        catalog: CLAUDE_CATALOG,
        agent: 'claude' as const,
        runtime,
        worktreeSelector: 'id:wt_local'
      }

      let settled: WorkerLaunchModelAuthority | 'waiting' = 'waiting'
      const dispatch = resolveWorkerLaunchModelAuthority(args).then((value) => {
        settled = value
      })
      await vi.advanceTimersByTimeAsync(10_000)
      // The dispatch does not wait out the probe's own 60s budget.
      expect(settled).toEqual(SEED_WORKER_LAUNCH_MODEL_AUTHORITY)

      release!()
      await dispatch
      const next = await resolveWorkerLaunchModelAuthority(args)

      // The abandoned probe still landed in the cache, so the next dispatch pays nothing.
      expect(discover).toHaveBeenCalledTimes(1)
      expect(next).toEqual({ source: 'live', modelIds: ['opus[1m]'] })
    } finally {
      vi.useRealTimers()
    }
  })

  it('re-probes a host once its cached list has expired', async () => {
    vi.useFakeTimers()
    try {
      const { runtime, discover } = probeRuntime(() => probeSuccess([liveModel('opus[1m]')]))
      const args = {
        catalog: CLAUDE_CATALOG,
        agent: 'claude' as const,
        runtime,
        worktreeSelector: 'id:wt_local'
      }

      await resolveWorkerLaunchModelAuthority(args)
      vi.setSystemTime(Date.now() + 3 * 60_000 + 1)
      await resolveWorkerLaunchModelAuthority(args)

      expect(discover).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('keys a remote host separately from the local one', async () => {
    const { runtime, discover } = probeRuntime(
      (worktreeSelector) =>
        probeSuccess([liveModel(worktreeSelector === 'id:wt_remote' ? 'opus' : 'opus[1m]')]),
      (worktreeSelector) => (worktreeSelector === 'id:wt_remote' ? 'ssh:box' : 'local')
    )

    const local = await resolveWorkerLaunchModelAuthority({
      catalog: CLAUDE_CATALOG,
      agent: 'claude',
      runtime,
      worktreeSelector: 'id:wt_local'
    })
    const remote = await resolveWorkerLaunchModelAuthority({
      catalog: CLAUDE_CATALOG,
      agent: 'claude',
      runtime,
      worktreeSelector: 'id:wt_remote'
    })

    expect(discover).toHaveBeenCalledTimes(2)
    expect(local.modelIds).toEqual(['opus[1m]'])
    expect(remote.modelIds).toEqual(['opus'])
  })

  it('keys each agent separately on the same host', async () => {
    const { runtime, discover } = probeRuntime(() => probeSuccess([liveModel('opus[1m]')]))

    await resolveWorkerLaunchModelAuthority({
      catalog: CLAUDE_CATALOG,
      agent: 'claude',
      runtime,
      worktreeSelector: 'id:wt_local'
    })
    // Grok, not Codex: only an agent whose discovery replaces the seed is probed at all.
    await resolveWorkerLaunchModelAuthority({
      catalog: GROK_CATALOG,
      agent: 'grok',
      runtime,
      worktreeSelector: 'id:wt_local'
    })

    expect(discover).toHaveBeenCalledTimes(2)
  })

  it('names the agent, the rejected id and the sorted ids the host actually listed', () => {
    expect(
      describeWorkerLaunchModelRejection({
        agent: 'claude',
        model: 'claude-opus-5',
        authority: { source: 'live', modelIds: ['sonnet', 'opus'] }
      })
    ).toBe(
      'Agent claude does not accept model claude-opus-5. Accepted ids (listed by the claude CLI on the executing host): opus, sonnet.'
    )
  })
})
