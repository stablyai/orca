import { resolve } from 'node:path'
import { expect, it } from 'vitest'
import { familyGoldens } from './derived-goldens'
import { hoistPreludeCheckpoints } from './prelude-checkpoints'
import { readScenarios } from './scenario-input'
import { bindCompletions, lifecycleSchedules } from './schedule-driver'

it('omits only the inventory admission following a refusal to a fully unmounted owner', () => {
  const manifest = readScenarios(
    resolve(import.meta.dirname, '../../../rpc-foundation/pilot-scenarios.json')
  )
  const base = manifest.scenarios.find((scenario) => scenario.id === 'inventory-lifecycle')
  if (!base) {
    throw new Error('missing inventory base scenario')
  }
  const golden = familyGoldens(manifest.scenarios).find(
    (item) => item.id === 'lifecycle-inventory-lifecycle'
  )
  if (!golden) {
    throw new Error('missing inventory lifecycle golden')
  }
  const original = hoistPreludeCheckpoints(
    { ...base, steps: bindCompletions(base.steps) },
    (['reset', 'unmount', 'blur'] as const).flatMap((action) => lifecycleSchedules(base, action))
  )
  const derived = golden.scenarios()
  expect(derived.map((scenario) => scenario.id)).toEqual(original.map((scenario) => scenario.id))
  expect(derived).toHaveLength(12)
  for (const [index, scenario] of original.entries()) {
    if (scenario.id !== 'inventory-lifecycle.unmount-before-1') {
      expect(derived[index]).toEqual(scenario)
      expect(JSON.stringify(derived[index])).toBe(JSON.stringify(scenario))
      continue
    }
    expect(scenario.steps).toHaveLength(13)
    expect(scenario.steps.slice(7, 10)).toEqual([
      { bind: 'old-inventory', request: 'files.list#1', params: { worktree: 'id:A' } },
      { bind: 'lifecycle-old-inventory', request: 'old-inventory', params: { worktree: 'id:A' } },
      {
        complete: 'lifecycle-old-inventory',
        params: { worktree: 'id:A' },
        reply: { ok: true, result: { files: [{ relativePath: 'old.ts' }] } }
      }
    ])
    const expected = {
      ...scenario,
      steps: [...scenario.steps.slice(0, 7), ...scenario.steps.slice(10)]
    }
    expect(derived[index]).toEqual(expected)
    expect(JSON.stringify(derived[index])).toBe(JSON.stringify(expected))
    expect(expected.steps.filter((step) => 'checkpoint' in step)).toEqual([
      { checkpoint: 'lifecycle-boundary' },
      { checkpoint: 'settled' },
      { checkpoint: 'remounted' }
    ])
    expect(expected.steps.filter((step) => 'bind' in step)).toEqual([
      {
        bind: 'lifecycle-files.searchPaths#1',
        request: 'files.searchPaths#1',
        params: { worktree: 'id:A', query: 'old', limit: 16 }
      }
    ])
  }
})
