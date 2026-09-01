// Perf gate for the pure resolver (plan §1368-1371). CI asserts ALGORITHMIC/count
// invariants — O(1) launch lookup, no per-field linear rescan, one index per
// revision — never a wall-clock threshold (heterogeneous runners). Wall-clock p95
// is emitted as PR evidence only; §1371 forbids a flaky timing assertion.

import os from 'node:os'
import { performance } from 'node:perf_hooks'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CustomTuiAgent, CustomTuiAgentId, GlobalSettings } from '../../shared/types'
import type { AgentCatalog } from '../../shared/agent-catalog-normalization'
import { resolveAgentLaunch, type ResolveAgentLaunchOutcome } from './resolve-agent-launch'
import {
  catalogOf,
  customAgent,
  customId,
  requestOf,
  settingsOf
} from './agent-launch-test-catalog'
import {
  resolveAgentLaunchSpawn,
  type AgentLaunchSpawnDeps,
  type AgentLaunchSpawnTarget
} from './agent-launch-spawn'
import { AgentLaunchBoundary } from './agent-launch-boundary'
import type * as AgentCatalogProjectionsModule from './agent-catalog-projections'
import {
  AgentLaunchAdmissionStore,
  LaunchAdmissionCoordinator
} from './agent-launch-admission-store'

// The pure-resolver gates below inject a PREBUILT catalog, so they never see the
// normalize pass production pays per launch. This counter lets the production-
// path gate assert that pass count directly.
const normalizeCatalogCalls = vi.hoisted(() => ({ count: 0 }))
vi.mock('./agent-catalog-projections', async (importOriginal) => {
  const actual = await importOriginal<typeof AgentCatalogProjectionsModule>()
  return {
    ...actual,
    normalizeCatalogFromSettings: (settings: GlobalSettings) => {
      normalizeCatalogCalls.count += 1
      return actual.normalizeCatalogFromSettings(settings)
    }
  }
})

type ScanCounts = { get: number; iterate: number; arrayScan: number }

/** Short env entries (`KEY_i=value-i`); 64 stays well under the 16 KiB cap. */
function makeEnv(entries: number): Record<string, string> {
  const env: Record<string, string> = {}
  for (let i = 0; i < entries; i += 1) {
    env[`CUSTOM_ENV_KEY_${i}`] = `value-${i}`
  }
  return env
}

/** `size` live custom agents on one resumable base; the middle agent is the
 *  launch target and carries `envEntries` env entries. */
function buildAgents(
  size: number,
  envEntries: number
): { agents: CustomTuiAgent[]; selectedId: CustomTuiAgentId } {
  const selectIndex = Math.floor(size / 2)
  const agents: CustomTuiAgent[] = []
  let selectedId: CustomTuiAgentId | null = null
  for (let i = 0; i < size; i += 1) {
    const id = customId('claude')
    if (i === selectIndex) {
      selectedId = id
    }
    agents.push(
      customAgent({
        id,
        label: `Agent ${i}`,
        args: '--model x',
        env: i === selectIndex ? makeEnv(envEntries) : {}
      })
    )
  }
  if (!selectedId) {
    throw new Error('fixture size must be positive')
  }
  return { agents, selectedId }
}

/** Prebuilt catalog for the PURE resolver gates. */
function buildFixture(
  size: number,
  envEntries: number
): { catalog: AgentCatalog; selectedId: CustomTuiAgentId } {
  const { agents, selectedId } = buildAgents(size, envEntries)
  return { catalog: catalogOf({ customTuiAgents: agents }), selectedId }
}

/** RAW persisted settings — what production actually hands the launch path. The
 *  host normalizes these per launch, so a prebuilt-catalog fixture measures a
 *  strictly cheaper pipeline than the one users pay for. */
function buildSettingsFixture(
  size: number,
  envEntries: number
): { settings: GlobalSettings; selectedId: CustomTuiAgentId } {
  const { agents, selectedId } = buildAgents(size, envEntries)
  return {
    settings: {
      ...settingsOf(),
      customTuiAgents: agents,
      deletedCustomTuiAgents: [],
      disabledTuiAgents: [],
      defaultTuiAgent: 'auto',
      agentCatalogRevision: 1
    } as unknown as GlobalSettings,
    selectedId
  }
}

const ARRAY_SCAN_PROPS = new Set([
  'forEach',
  'map',
  'filter',
  'some',
  'every',
  'find',
  'findIndex',
  'reduce',
  'reduceRight',
  'flatMap',
  'indexOf',
  'includes',
  'slice'
])

/** Wrap the catalog's custom-agent index and list so any full scan or per-entry
 *  read is counted. A size-independent `get` count with zero iteration/array scan
 *  is the structural O(1) proof — robust across runners, unlike a timer. */
function instrument(catalog: AgentCatalog): { catalog: AgentCatalog; counts: ScanCounts } {
  const counts: ScanCounts = { get: 0, iterate: 0, arrayScan: 0 }
  const liveById = new Proxy(catalog.liveById as Map<CustomTuiAgentId, unknown>, {
    get(target, prop) {
      if (prop === 'get') {
        return (key: CustomTuiAgentId) => {
          counts.get += 1
          return target.get(key)
        }
      }
      if (
        prop === Symbol.iterator ||
        prop === 'forEach' ||
        prop === 'keys' ||
        prop === 'values' ||
        prop === 'entries'
      ) {
        counts.iterate += 1
      }
      const value = Reflect.get(target, prop, target)
      return typeof value === 'function'
        ? (value as (...a: unknown[]) => unknown).bind(target)
        : value
    }
  }) as unknown as AgentCatalog['liveById']
  const liveCustomAgents = new Proxy(catalog.liveCustomAgents as unknown[], {
    get(target, prop) {
      if (prop === Symbol.iterator || (typeof prop === 'string' && ARRAY_SCAN_PROPS.has(prop))) {
        counts.arrayScan += 1
      } else if (typeof prop === 'string' && /^\d+$/.test(prop)) {
        counts.arrayScan += 1
      }
      const value = Reflect.get(target, prop, target)
      return typeof value === 'function'
        ? (value as (...a: unknown[]) => unknown).bind(target)
        : value
    }
  }) as unknown as AgentCatalog['liveCustomAgents']
  return { catalog: { ...catalog, liveById, liveCustomAgents }, counts }
}

function resolveOnce(
  catalog: AgentCatalog,
  selectedId: CustomTuiAgentId
): ResolveAgentLaunchOutcome {
  return resolveAgentLaunch(
    requestOf({ selection: { kind: 'agent', agent: selectedId } }),
    catalog,
    settingsOf()
  )
}

describe('resolve-agent-launch performance budget', () => {
  it('resolves a custom launch in O(1): lookup cost does not grow with catalog size', () => {
    const small = buildFixture(2, 8)
    const large = buildFixture(1000, 8)
    const s = instrument(small.catalog)
    const l = instrument(large.catalog)

    expect(resolveOnce(s.catalog, small.selectedId).ok).toBe(true)
    expect(resolveOnce(l.catalog, large.selectedId).ok).toBe(true)

    // Never iterates the full custom-agent index or list at any size.
    expect(s.counts.iterate).toBe(0)
    expect(l.counts.iterate).toBe(0)
    expect(s.counts.arrayScan).toBe(0)
    expect(l.counts.arrayScan).toBe(0)
    // Identical lookup cost at 2 and 1,000 agents proves O(1), not O(n).
    expect(l.counts.get).toBe(s.counts.get)
    expect(l.counts.get).toBeGreaterThan(0)
    expect(l.counts.get).toBeLessThanOrEqual(20)
  })

  it('derives every field from one fetched entry: env size adds no catalog lookups', () => {
    const lean = buildFixture(1000, 0)
    const rich = buildFixture(1000, 64)
    const li = instrument(lean.catalog)
    const ri = instrument(rich.catalog)

    expect(resolveOnce(li.catalog, lean.selectedId).ok).toBe(true)
    expect(resolveOnce(ri.catalog, rich.selectedId).ok).toBe(true)

    // 64 env entries vs 0 must not trigger extra command/args/env/label/base scans.
    expect(ri.counts.get).toBe(li.counts.get)
    expect(li.counts.arrayScan).toBe(0)
    expect(ri.counts.arrayScan).toBe(0)
  })

  it('indexes the catalog once per revision and reuses it across resolutions', () => {
    const { catalog, selectedId } = buildFixture(1000, 64)
    // One normalize pass built the full index.
    expect(catalog.liveById.size).toBe(1000)
    expect(catalog.liveCustomAgents.length).toBe(1000)

    const first = resolveOnce(catalog, selectedId)
    const second = resolveOnce(catalog, selectedId)
    expect(first.ok).toBe(true)
    expect(second.ok).toBe(true)
    if (first.ok && second.ok) {
      // Same catalog object, no re-normalize: identical resolved argv.
      expect([...second.launch.argv]).toEqual([...first.launch.argv])
    }
  })

  it('records resolver throughput as PR evidence (never a CI wall-clock assertion)', () => {
    const { catalog, selectedId } = buildFixture(1000, 64)
    const request = requestOf({ selection: { kind: 'agent', agent: selectedId } })
    const settings = settingsOf()

    for (let i = 0; i < 2000; i += 1) {
      resolveAgentLaunch(request, catalog, settings)
    }

    const runs = process.env.ORCA_PERF_EVIDENCE ? 100 : 3
    const iterations = 10_000
    const perOpMs: number[] = []
    let okAll = true
    for (let r = 0; r < runs; r += 1) {
      const start = performance.now()
      for (let i = 0; i < iterations; i += 1) {
        if (!resolveAgentLaunch(request, catalog, settings).ok) {
          okAll = false
        }
      }
      perOpMs.push((performance.now() - start) / iterations)
    }
    perOpMs.sort((a, b) => a - b)
    const p95 = perOpMs[Math.min(perOpMs.length - 1, Math.floor(perOpMs.length * 0.95))]

    // Evidence only — asserted nowhere (plan §1371: no wall-clock CI threshold).
    console.log(
      `[resolve-agent-launch.perf] node=${process.version} cpu=${os.cpus()[0]?.model ?? 'unknown'} ` +
        `runs=${runs} iterationsPerRun=${iterations} p95PerResolutionMs=${p95.toFixed(5)} budgetMs=2`
    )
    // Correctness gate: every measured resolution produced a launch.
    expect(okAll).toBe(true)
  })
})

// P1-21: the gates above resolve a PREBUILT catalog, so they never exercise the
// normalize pass the host runs per launch — the production surface (settings →
// normalized catalog → resolver → boundary) is measured here instead.
describe('production launch path performance budget (P1-21)', () => {
  const PRODUCTION_TARGET: AgentLaunchSpawnTarget = {
    platform: 'linux',
    shell: 'posix',
    isRemote: false,
    executionHostId: 'local',
    targetHomePath: '/home/dev',
    // null = detection unavailable, the honest host default; never a fabricated set.
    detectedStockBaseAgents: null
  }

  function productionDeps(getSettings: () => GlobalSettings): AgentLaunchSpawnDeps {
    return {
      getSettings,
      getCatalogRevision: () => getSettings().agentCatalogRevision ?? 1,
      boundary: new AgentLaunchBoundary({
        admissionStore: new AgentLaunchAdmissionStore(),
        coordinator: new LaunchAdmissionCoordinator()
      })
    }
  }

  async function launchOnce(
    deps: AgentLaunchSpawnDeps,
    selectedId: CustomTuiAgentId
  ): Promise<boolean> {
    const result = await resolveAgentLaunchSpawn(deps, {
      request: { selection: { kind: 'agent', agent: selectedId }, prompt: 'go' },
      intent: { kind: 'interactive', client: 'desktop' },
      target: PRODUCTION_TARGET,
      variables: { repoPath: '/repo', worktreePath: '/repo/wt' },
      scope: 'perf-launch',
      principal: { kind: 'local' }
    })
    if (result.ok) {
      // Release the admitted slot so a repeated-launch loop never hits the cap.
      deps.boundary.settleAgentLaunch(result.receipt.launchToken, 'failed')
    }
    return result.ok
  }

  beforeEach(() => {
    normalizeCatalogCalls.count = 0
  })

  it('normalizes a 2,500-agent catalog once per launch, not once per resolve pass', async () => {
    const { settings, selectedId } = buildSettingsFixture(2500, 8)
    const deps = productionDeps(() => settings)

    expect(await launchOnce(deps, selectedId)).toBe(true)

    // The boundary resolves twice (initial view + coordinator re-resolve); both
    // passes must share one normalized catalog.
    expect(normalizeCatalogCalls.count).toBe(1)
  })

  it('reuses one normalized catalog across launches on an unchanged settings revision', async () => {
    const { settings, selectedId } = buildSettingsFixture(2500, 8)
    const deps = productionDeps(() => settings)

    for (let i = 0; i < 8; i += 1) {
      expect(await launchOnce(deps, selectedId)).toBe(true)
    }
    expect(normalizeCatalogCalls.count).toBe(1)
  })

  it('re-normalizes after the settings object is replaced (a real catalog edit)', async () => {
    const { settings, selectedId } = buildSettingsFixture(2500, 8)
    let current = settings
    const deps = productionDeps(() => current)

    expect(await launchOnce(deps, selectedId)).toBe(true)
    current = { ...settings, agentCatalogRevision: 2 } as GlobalSettings
    expect(await launchOnce(deps, selectedId)).toBe(true)

    expect(normalizeCatalogCalls.count).toBe(2)
  })

  it('records production launch throughput as PR evidence (never a CI wall-clock assertion)', async () => {
    const { settings, selectedId } = buildSettingsFixture(2500, 8)
    let current = settings
    const deps = productionDeps(() => current)
    let okAll = true

    for (let i = 0; i < 5; i += 1) {
      okAll = (await launchOnce(deps, selectedId)) && okAll
    }

    const runs = process.env.ORCA_PERF_EVIDENCE ? 50 : 5
    const coldMs: number[] = []
    const warmMs: number[] = []
    for (let r = 0; r < runs; r += 1) {
      // Cold: a fresh settings revision, so this launch pays the normalize.
      current = { ...settings, agentCatalogRevision: r + 10 } as GlobalSettings
      let start = performance.now()
      okAll = (await launchOnce(deps, selectedId)) && okAll
      coldMs.push(performance.now() - start)
      // Warm: same revision, so the normalized catalog is reused.
      start = performance.now()
      okAll = (await launchOnce(deps, selectedId)) && okAll
      warmMs.push(performance.now() - start)
    }
    const p95 = (samples: number[]): number => {
      const sorted = [...samples].sort((a, b) => a - b)
      return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] ?? 0
    }

    // Evidence only — asserted nowhere (plan §1371: no wall-clock CI threshold).
    console.log(
      `[agent-launch-spawn.perf] node=${process.version} cpu=${os.cpus()[0]?.model ?? 'unknown'} ` +
        `agents=2500 runs=${runs} p95ColdLaunchMs=${p95(coldMs).toFixed(3)} ` +
        `p95WarmLaunchMs=${p95(warmMs).toFixed(3)}`
    )
    expect(okAll).toBe(true)
  })
})
