import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { getAgentSessionOptionCatalog } from '../../../../../../shared/agent-session-option-catalog'
import { ORCHESTRATION_WORKER_LAUNCH_PREFERENCES_RUNTIME_CAPABILITY } from '../../../../../../shared/protocol-version'
import {
  discoverCommitMessageModelsLocal,
  type DiscoverCommitMessageModelsResult
} from '../../../../../text-generation/commit-message-text-generation'
import {
  assertWorkerLaunchPreferencesCreateTerminal,
  assertWorkerLaunchPreferencesRuntimeSupported,
  createPendingWorkerLaunchReceipt,
  resolveFederatedWorkerLaunchReceipt,
  resolveWorkerLaunchPreferences,
  type AgentLaunchModelDiscovery
} from './worker-launch-preferences'
import { WorkerStartParams } from './worker-start-schema'

/** A fresh function reference each call, matching how production tags one
 *  process-lifetime probe by executor identity (per agent) — each test gets its own,
 *  never sharing a cached result with another test's stub. */
const PROBE_AGENT_LABELS = { claude: 'Claude', codex: 'Codex', cursor: 'Cursor' } as const

function agentProbeAccepting(
  agentId: 'claude' | 'codex' | 'cursor',
  models: { id: string; thinkingLevels?: string[] }[]
): AgentLaunchModelDiscovery {
  const capabilityModels = models.map((model) => ({
    id: model.id,
    label: model.id,
    ...(model.thinkingLevels
      ? { thinkingLevels: model.thinkingLevels.map((id) => ({ id, label: id })) }
      : {})
  }))
  return async (): Promise<DiscoverCommitMessageModelsResult> => ({
    success: true,
    capability: {
      id: agentId,
      label: PROBE_AGENT_LABELS[agentId],
      modelSource: 'dynamic',
      models: capabilityModels,
      defaultModelId: models[0]?.id ?? ''
    },
    models: capabilityModels,
    defaultModelId: models[0]?.id ?? '',
    catalogOrigin: 'probe'
  })
}

function claudeProbeAccepting(
  models: { id: string; thinkingLevels?: string[] }[]
): AgentLaunchModelDiscovery {
  return agentProbeAccepting('claude', models)
}

function codexProbeAccepting(
  models: { id: string; thinkingLevels?: string[] }[]
): AgentLaunchModelDiscovery {
  return agentProbeAccepting('codex', models)
}

function cursorProbeAccepting(
  models: { id: string; thinkingLevels?: string[] }[]
): AgentLaunchModelDiscovery {
  return agentProbeAccepting('cursor', models)
}

function agentProbeUnavailable(error: string): AgentLaunchModelDiscovery {
  return async (): Promise<DiscoverCommitMessageModelsResult> => ({ success: false, error })
}

describe('orchestration worker launch preferences', () => {
  it('verifies the requested Claude model and effort against the installed CLI', async () => {
    // Why: issue #10846 — `effective` must come from the installed CLI, never a
    // clone of `requested`. The probe stub stands in for discoverModelsLocal
    // (the existing local discovery executor), so no real CLI is spawned.
    await expect(
      resolveWorkerLaunchPreferences({
        agent: 'claude',
        model: 'aws-bedrock-opus-5',
        effort: 'high',
        discoverAgentModels: claudeProbeAccepting([
          { id: 'aws-bedrock-opus-5', thinkingLevels: ['low', 'medium', 'high'] }
        ])
      })
    ).resolves.toEqual({
      preferences: { model: 'aws-bedrock-opus-5', effort: 'high' },
      receipt: {
        requested: { agent: 'claude', model: 'aws-bedrock-opus-5', effort: 'high' },
        effective: { agent: 'claude', model: 'aws-bedrock-opus-5', effort: 'high' },
        source: 'probe'
      }
    })
  })

  it('rejects a model/effort the installed Claude CLI does not accept, with the CLI-sourced reason', async () => {
    // Why: 'max' passes the static catalog's extended effort choices (so this
    // exercises the PROBE's rejection, not the earlier catalog check) but the
    // stubbed installed CLI only reports low/medium/high for this model.
    await expect(
      resolveWorkerLaunchPreferences({
        agent: 'claude',
        model: 'aws-bedrock-opus-5',
        effort: 'max',
        discoverAgentModels: claudeProbeAccepting([
          { id: 'aws-bedrock-opus-5', thinkingLevels: ['low', 'medium', 'high'] }
        ])
      })
    ).rejects.toThrow('does not accept effort "max"')

    await expect(
      resolveWorkerLaunchPreferences({
        agent: 'claude',
        model: 'not-a-real-model',
        discoverAgentModels: claudeProbeAccepting([{ id: 'aws-bedrock-opus-5' }])
      })
    ).rejects.toThrow('does not list model "not-a-real-model"')
  })

  it('falls back to unverified (not a clone) when the installed CLI cannot be asked', async () => {
    await expect(
      resolveWorkerLaunchPreferences({
        agent: 'claude',
        model: 'aws-bedrock-opus-5',
        discoverAgentModels: agentProbeUnavailable('claude not found on PATH.')
      })
    ).resolves.toEqual({
      preferences: { model: 'aws-bedrock-opus-5' },
      receipt: {
        requested: { agent: 'claude', model: 'aws-bedrock-opus-5', effort: null },
        effective: null,
        source: 'unverified',
        unverifiedReason: 'claude not found on PATH.'
      }
    })
  })

  it('labels a no-model receipt catalog rather than leaving source unset (I1)', async () => {
    // Why: nothing was requested to override, so effective trivially equals requested -- but the
    // rule is effective is never a bare clone with no source label, even in this trivial case.
    await expect(resolveWorkerLaunchPreferences({ agent: 'codex' })).resolves.toEqual({
      preferences: undefined,
      receipt: {
        requested: { agent: 'codex', model: null, effort: null },
        effective: { agent: 'codex', model: null, effort: null },
        source: 'catalog'
      }
    })
  })

  it('never probes and reports unverified when the worker placement is remote (I1)', async () => {
    let calls = 0
    const countingProbe: AgentLaunchModelDiscovery = async (...probeArgs) => {
      calls++
      return claudeProbeAccepting([
        { id: 'aws-bedrock-opus-5', thinkingLevels: ['low', 'medium', 'high'] }
      ])(...probeArgs)
    }

    await expect(
      resolveWorkerLaunchPreferences({
        agent: 'claude',
        model: 'aws-bedrock-opus-5',
        effort: 'high',
        remotePlacement: true,
        discoverAgentModels: countingProbe
      })
    ).resolves.toEqual({
      preferences: { model: 'aws-bedrock-opus-5', effort: 'high' },
      receipt: {
        requested: { agent: 'claude', model: 'aws-bedrock-opus-5', effort: 'high' },
        effective: null,
        source: 'unverified',
        unverifiedReason: expect.stringContaining('remote')
      }
    })
    // Why assert this, not only the receipt shape: a local probe result can never speak for a
    // remote placement, so the fix must skip the probe entirely, not merely relabel its answer.
    expect(calls).toBe(0)
  })

  it('never probes and reports unverified when the agent has a launch command override (I1)', async () => {
    let calls = 0
    const countingProbe: AgentLaunchModelDiscovery = async (...probeArgs) => {
      calls++
      return claudeProbeAccepting([{ id: 'aws-bedrock-opus-5' }])(...probeArgs)
    }

    await expect(
      resolveWorkerLaunchPreferences({
        agent: 'claude',
        model: 'aws-bedrock-opus-5',
        agentCommandOverride: 'my-claude-wrapper --flag',
        discoverAgentModels: countingProbe
      })
    ).resolves.toEqual({
      preferences: { model: 'aws-bedrock-opus-5' },
      receipt: {
        requested: { agent: 'claude', model: 'aws-bedrock-opus-5', effort: null },
        effective: null,
        source: 'unverified',
        unverifiedReason: expect.stringContaining('custom launch command')
      }
    })
    expect(calls).toBe(0)
  })

  it('does not invent an effort when only a model is requested (I2)', async () => {
    await expect(
      resolveWorkerLaunchPreferences({
        agent: 'codex',
        model: 'gpt-5.6-sol',
        discoverAgentModels: codexProbeAccepting([{ id: 'gpt-5.6-sol' }])
      })
    ).resolves.toMatchObject({ preferences: { model: 'gpt-5.6-sol' } })
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
  ])('enforces the Codex effort ceiling for $model (I2)', async ({ model, accepted, rejected }) => {
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
      // Why stubbed rather than 'catalog' (I2): Codex's model is now probe-verified, but its
      // effort still isn't -- the installed CLI's `debug models` never advertises 'minimal',
      // which this per-model ceiling table (correctly) treats as every model's floor, so
      // checking effort against the probe would reject a selection the catalog calls valid.
      await expect(
        resolveWorkerLaunchPreferences({
          agent: 'codex',
          model,
          effort: effortValue,
          discoverAgentModels: codexProbeAccepting([{ id: model }])
        })
      ).resolves.toMatchObject({
        preferences: { model, effort: effortValue },
        receipt: { source: 'probe', effortSource: 'catalog' }
      })
    }
    for (const effortValue of rejected) {
      await expect(
        resolveWorkerLaunchPreferences({ agent: 'codex', model, effort: effortValue })
      ).rejects.toThrow(`does not support effort ${effortValue}`)
    }
  })

  it('rejects effort without a model', async () => {
    await expect(
      resolveWorkerLaunchPreferences({ agent: 'codex', effort: 'high' })
    ).rejects.toThrow('--effort requires --model')
  })

  it('rejects model selection for agents without a launch catalog', async () => {
    await expect(
      resolveWorkerLaunchPreferences({ agent: 'grok', model: 'grok-code-fast-1' })
    ).rejects.toThrow('does not support launch-time model selection')
  })

  it('does not expose deprecated Gemini model selection to worker-start', async () => {
    await expect(
      resolveWorkerLaunchPreferences({ agent: 'gemini', model: 'gemini-3-pro-preview' })
    ).rejects.toThrow('does not support launch-time model selection')
  })

  describe('Codex worker launch preferences (I2)', () => {
    it('verifies the requested Codex model against the installed CLI; effort stays catalog-validated', async () => {
      // Why: I2 -- Codex's model now earns `source: 'probe'` the same way Claude's does, but
      // effort does not: the CLI's own `debug models` never advertises 'minimal', which the
      // static catalog offers as every model's floor, so effort stays catalog-validated and the
      // receipt says so via `effortSource`. The probe stub stands in for discoverModelsLocal, so
      // no real CLI is spawned.
      await expect(
        resolveWorkerLaunchPreferences({
          agent: 'codex',
          model: 'gpt-5.6-sol',
          effort: 'ultra',
          discoverAgentModels: codexProbeAccepting([{ id: 'gpt-5.6-sol' }])
        })
      ).resolves.toEqual({
        preferences: { model: 'gpt-5.6-sol', effort: 'ultra' },
        receipt: {
          requested: { agent: 'codex', model: 'gpt-5.6-sol', effort: 'ultra' },
          effective: { agent: 'codex', model: 'gpt-5.6-sol', effort: 'ultra' },
          source: 'probe',
          effortSource: 'catalog'
        }
      })
    })

    it('omits effortSource when no effort was requested', async () => {
      await expect(
        resolveWorkerLaunchPreferences({
          agent: 'codex',
          model: 'gpt-5.6-sol',
          discoverAgentModels: codexProbeAccepting([{ id: 'gpt-5.6-sol' }])
        })
      ).resolves.toEqual({
        preferences: { model: 'gpt-5.6-sol' },
        receipt: {
          requested: { agent: 'codex', model: 'gpt-5.6-sol', effort: null },
          effective: { agent: 'codex', model: 'gpt-5.6-sol', effort: null },
          source: 'probe'
        }
      })
    })

    it('rejects a model the installed Codex CLI does not list, with the CLI-sourced reason', async () => {
      await expect(
        resolveWorkerLaunchPreferences({
          agent: 'codex',
          model: 'gpt-5.6-sol',
          discoverAgentModels: codexProbeAccepting([{ id: 'gpt-5.2-codex' }])
        })
      ).rejects.toThrow('does not list model "gpt-5.6-sol"')
    })

    it('falls back to unverified (not a clone) when the installed Codex CLI cannot be asked', async () => {
      await expect(
        resolveWorkerLaunchPreferences({
          agent: 'codex',
          model: 'gpt-5.6-sol',
          discoverAgentModels: agentProbeUnavailable('codex not found on PATH.')
        })
      ).resolves.toEqual({
        preferences: { model: 'gpt-5.6-sol' },
        receipt: {
          requested: { agent: 'codex', model: 'gpt-5.6-sol', effort: null },
          effective: null,
          source: 'unverified',
          unverifiedReason: 'codex not found on PATH.'
        }
      })
    })

    it('never probes and reports unverified when the worker placement is remote (I1/I2)', async () => {
      let calls = 0
      const countingProbe: AgentLaunchModelDiscovery = async (...probeArgs) => {
        calls++
        return codexProbeAccepting([{ id: 'gpt-5.6-sol' }])(...probeArgs)
      }
      await expect(
        resolveWorkerLaunchPreferences({
          agent: 'codex',
          model: 'gpt-5.6-sol',
          remotePlacement: true,
          discoverAgentModels: countingProbe
        })
      ).resolves.toEqual({
        preferences: { model: 'gpt-5.6-sol' },
        receipt: {
          requested: { agent: 'codex', model: 'gpt-5.6-sol', effort: null },
          effective: null,
          source: 'unverified',
          unverifiedReason: expect.stringContaining('remote')
        }
      })
      // Why assert this, not only the receipt shape: a local probe result can never speak for a
      // remote placement, so the fix must skip the probe entirely, not merely relabel its answer.
      expect(calls).toBe(0)
    })

    it('never probes and reports unverified when the agent has a launch command override (I1/I2)', async () => {
      let calls = 0
      const countingProbe: AgentLaunchModelDiscovery = async (...probeArgs) => {
        calls++
        return codexProbeAccepting([{ id: 'gpt-5.6-sol' }])(...probeArgs)
      }
      await expect(
        resolveWorkerLaunchPreferences({
          agent: 'codex',
          model: 'gpt-5.6-sol',
          agentCommandOverride: 'my-codex-wrapper --flag',
          discoverAgentModels: countingProbe
        })
      ).resolves.toEqual({
        preferences: { model: 'gpt-5.6-sol' },
        receipt: {
          requested: { agent: 'codex', model: 'gpt-5.6-sol', effort: null },
          effective: null,
          source: 'unverified',
          unverifiedReason: expect.stringContaining('custom launch command')
        }
      })
      expect(calls).toBe(0)
    })
  })

  describe('Cursor worker launch preferences (I3)', () => {
    // Why plain `await` + `toEqual`/`toThrow` here, unlike the Claude/Codex blocks above: at
    // upstream 539d4d1f32b4 resolveWorkerLaunchPreferences is synchronous (no probe exists at
    // all), and this vitest version's `expect(x).resolves`/`.rejects` throws
    // "You must provide a Promise" for a plain return value instead of comparing it -- an
    // infrastructure failure, not proof of the clone bug. Awaiting a non-Promise return is a
    // no-op, so this style reproduces the real behavioural mismatch on both upstream and Odin.
    it('verifies the requested Cursor model against the installed CLI, never a clone of requested', async () => {
      // Why this reproduces residual I for Cursor: CURSOR_SESSION_OPTION_CATALOG sets
      // supportsWorkerLaunchPreferences: true, so a cursor launch reaches this receipt code at
      // all, but PROBEABLE_LAUNCH_AGENTS used to exclude cursor, falling to the bottom
      // catalog-only branch (`createWorkerLaunchReceipt`'s `effective: { ...selection }`) -- a
      // structural clone of requested, honestly labelled 'catalog' but never checked against the
      // installed CLI. This asserts the same probe reuse Claude/Codex already earn.
      const result = await resolveWorkerLaunchPreferences({
        agent: 'cursor',
        model: 'claude-opus-4-8',
        effort: 'high',
        discoverAgentModels: cursorProbeAccepting([{ id: 'claude-opus-4-8' }])
      })
      expect(result).toEqual({
        preferences: { model: 'claude-opus-4-8', effort: 'high' },
        receipt: {
          requested: { agent: 'cursor', model: 'claude-opus-4-8', effort: 'high' },
          effective: { agent: 'cursor', model: 'claude-opus-4-8', effort: 'high' },
          source: 'probe',
          effortSource: 'catalog'
        }
      })
    })

    it('rejects a model the installed Cursor CLI does not list, with the CLI-sourced reason', async () => {
      await expect(async () => {
        await resolveWorkerLaunchPreferences({
          agent: 'cursor',
          model: 'claude-opus-4-8',
          discoverAgentModels: cursorProbeAccepting([{ id: 'gpt-5.3-codex' }])
        })
      }).rejects.toThrow('The installed Cursor CLI does not list model "claude-opus-4-8"')
    })

    it('falls back to unverified (not a clone) when the installed Cursor CLI cannot be asked', async () => {
      const result = await resolveWorkerLaunchPreferences({
        agent: 'cursor',
        model: 'claude-opus-4-8',
        discoverAgentModels: agentProbeUnavailable('cursor-agent not found on PATH.')
      })
      expect(result).toEqual({
        preferences: { model: 'claude-opus-4-8' },
        receipt: {
          requested: { agent: 'cursor', model: 'claude-opus-4-8', effort: null },
          effective: null,
          source: 'unverified',
          unverifiedReason: 'cursor-agent not found on PATH.'
        }
      })
    })

    it('never probes and reports unverified when the worker placement is remote (I1/I3)', async () => {
      let calls = 0
      const countingProbe: AgentLaunchModelDiscovery = async (...probeArgs) => {
        calls++
        return cursorProbeAccepting([{ id: 'claude-opus-4-8' }])(...probeArgs)
      }
      const result = await resolveWorkerLaunchPreferences({
        agent: 'cursor',
        model: 'claude-opus-4-8',
        remotePlacement: true,
        discoverAgentModels: countingProbe
      })
      expect(result).toEqual({
        preferences: { model: 'claude-opus-4-8' },
        receipt: {
          requested: { agent: 'cursor', model: 'claude-opus-4-8', effort: null },
          effective: null,
          source: 'unverified',
          unverifiedReason: expect.stringContaining('remote')
        }
      })
      expect(calls).toBe(0)
    })
  })

  describe('Launch receipt catalogOrigin honesty (I4)', () => {
    it('labels a static-catalog-fallback probe answer catalog, not probe (I4a)', async () => {
      // Why this reproduces I4a: discoverCommitMessageModelsLocal's finalizeModelDiscoveryOutput
      // returns success: true, catalogOrigin: 'spec' when the installed CLI exits 0 but reports no
      // parseable model list (the Claude spec documents this for older CLIs) and falls back to the
      // static catalog. verifyAgentLaunchSelection used to key its 'accepted' outcome on
      // `result.success` alone, so this fallback earned the same `source: 'probe'` label as a real
      // live-CLI answer even though the installed CLI never actually named this model.
      const staticCatalogFallback: AgentLaunchModelDiscovery = async () => ({
        success: true,
        capability: {
          id: 'claude',
          label: 'Claude',
          modelSource: 'dynamic',
          models: [{ id: 'aws-bedrock-opus-5', label: 'aws-bedrock-opus-5' }],
          defaultModelId: 'aws-bedrock-opus-5'
        },
        models: [{ id: 'aws-bedrock-opus-5', label: 'aws-bedrock-opus-5' }],
        defaultModelId: 'aws-bedrock-opus-5',
        catalogOrigin: 'spec'
      })

      await expect(
        resolveWorkerLaunchPreferences({
          agent: 'claude',
          model: 'aws-bedrock-opus-5',
          discoverAgentModels: staticCatalogFallback
        })
      ).resolves.toEqual({
        preferences: { model: 'aws-bedrock-opus-5' },
        receipt: {
          requested: { agent: 'claude', model: 'aws-bedrock-opus-5', effort: null },
          effective: { agent: 'claude', model: 'aws-bedrock-opus-5', effort: null },
          source: 'catalog'
        }
      })
    })

    it('re-probes after a transient failure instead of pinning every later launch to unverified (I4b)', async () => {
      // Why this reproduces I4b: probeAgentModelsOnce memoised the discover() promise for the
      // process lifetime regardless of outcome, keyed by (executor, agentId). A single transient
      // miss (CLI briefly unreachable) cached a rejected/false promise forever, so a second
      // worker-start for the same agent -- using the SAME discover reference, as production does
      // via discoverCommitMessageModelsLocal -- replayed the stale failure instead of asking again.
      let calls = 0
      const flaky: AgentLaunchModelDiscovery = async () => {
        calls++
        if (calls === 1) {
          return { success: false, error: 'claude timed out on this attempt.' }
        }
        return {
          success: true,
          capability: {
            id: 'claude',
            label: 'Claude',
            modelSource: 'dynamic',
            models: [{ id: 'aws-bedrock-opus-5', label: 'aws-bedrock-opus-5' }],
            defaultModelId: 'aws-bedrock-opus-5'
          },
          models: [{ id: 'aws-bedrock-opus-5', label: 'aws-bedrock-opus-5' }],
          defaultModelId: 'aws-bedrock-opus-5',
          catalogOrigin: 'probe'
        }
      }

      const first = await resolveWorkerLaunchPreferences({
        agent: 'claude',
        model: 'aws-bedrock-opus-5',
        discoverAgentModels: flaky
      })
      expect(first.receipt.source).toBe('unverified')

      const second = await resolveWorkerLaunchPreferences({
        agent: 'claude',
        model: 'aws-bedrock-opus-5',
        discoverAgentModels: flaky
      })
      expect(second.receipt.source).toBe('probe')
      expect(calls).toBe(2)
    })
  })

  describe('Grok worker launch preferences (I2)', () => {
    it('is rejected before any probe: grok has no worker-launch-preferences catalog support', async () => {
      // Why this pins a boundary rather than exercising a probe: unlike Claude and Codex,
      // GROK_SESSION_OPTION_CATALOG has no `supportsWorkerLaunchPreferences`, so a grok
      // --model/--effort worker-start throws above PROBEABLE_LAUNCH_AGENTS' dispatch -- there is
      // no receipt here for grok's model-list probe to attach to. That probe is wired and
      // tested at the discovery layer (grok-model-list-probe.test.ts, and the real-CLI check
      // below), ready for the day grok's catalog opts in. This test fails loudly if a future
      // change starts probing grok here without updating this contract.
      let calls = 0
      const countingProbe: AgentLaunchModelDiscovery = async () => {
        calls++
        return { success: false, error: 'unused' }
      }
      await expect(
        resolveWorkerLaunchPreferences({
          agent: 'grok',
          model: 'grok-4.6',
          discoverAgentModels: countingProbe
        })
      ).rejects.toThrow('does not support launch-time model selection')
      expect(calls).toBe(0)
    })
  })

  describe('Real installed-CLI integration (I2)', () => {
    // Why guarded rather than mocked: these are the "does the real thing work" checks the unit
    // tests above (all stubbed) cannot provide. Skips cleanly on a host without the binary.
    const codexAvailable =
      spawnSync('codex', ['--version'], { stdio: 'ignore', windowsHide: true, timeout: 5_000 })
        .status === 0
    const grokAvailable =
      spawnSync('grok', ['--version'], { stdio: 'ignore', windowsHide: true, timeout: 5_000 })
        .status === 0

    it.skipIf(!codexAvailable)(
      'resolves a real Codex model through the installed CLI with source: probe (I2)',
      async () => {
        // Why this exact model/effort: 'gpt-5.6-sol' is both a static-catalog seed (so the
        // earlier effort-ceiling gate accepts 'high') and, on this machine, a real slug
        // `codex debug models` reports -- confirmed by running that command directly.
        const result = await resolveWorkerLaunchPreferences({
          agent: 'codex',
          model: 'gpt-5.6-sol',
          effort: 'high'
        })
        expect(result.receipt.source).toBe('probe')
        expect(result.receipt.effortSource).toBe('catalog')
        expect(result.receipt.effective).toEqual({
          agent: 'codex',
          model: 'gpt-5.6-sol',
          effort: 'high'
        })
      },
      20_000
    )

    it.skipIf(!grokAvailable)(
      'resolves the real Grok model list through the shared discovery executor (I2)',
      async () => {
        // Why discoverCommitMessageModelsLocal directly, not resolveWorkerLaunchPreferences:
        // grok has no supportsWorkerLaunchPreferences (see the describe block above), so the
        // receipt path can never be exercised end to end for it. This proves the SAME shared
        // executor Codex and Claude use resolves grok's real model list -- the wiring residual
        // I2 asked for, at the layer that actually exists for grok today.
        const result = await discoverCommitMessageModelsLocal('grok', process.env)
        expect(result.success).toBe(true)
        if (result.success) {
          expect(result.models.length).toBeGreaterThan(0)
          expect(result.models.some((model) => model.id === 'grok-4.6')).toBe(true)
        }
      },
      20_000
    )
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

    // Why effective: null, not a clone of requested (I1): the federated coordinator's last
    // resort before the remote server answers never verifies, so a clone here would look
    // identical to a verified receipt to any reader that checks `effective` without also
    // checking `source` (issue #10846).
    expect(resolveFederatedWorkerLaunchReceipt(undefined, requested, true)).toEqual({
      requested: requested.requested,
      effective: null,
      source: 'unverified',
      unverifiedReason: 'The worker server did not report which launch options it applied.'
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
