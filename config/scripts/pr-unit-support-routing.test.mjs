import { beforeAll, describe, expect, it } from 'vitest'
import { classifyPrJobs } from './pr-code-change-scope.mjs'
import { selectPrE2eSpecs } from './pr-e2e-source-routing.mjs'
import {
  buildUnitDependencyGraph,
  collectUnitDependencyGraph,
  unitConsumers
} from './ci-unit-dependency-graph.mjs'
import { CROSS_VERSION_WIRE_DIR, discoverUnitFiles } from './ci-unit-files.mjs'
import { planUnitSelection } from './ci-unit-selection.mjs'

const harness = 'src/renderer/src/runtime/web-session-tabs-sync-test-harness.ts'
const structuredSessionHarness =
  'src/renderer/src/components/native-chat/NativeChatStructuredSession.test-harness.tsx'

const unitHarnesses = [
  harness,
  structuredSessionHarness,
  'src/renderer/src/store/slices/editor-slice-test-harness.ts',
  'src/renderer/src/store/slices/browser-slice-test-harness.ts',
  'src/renderer/src/runtime/web-runtime-session-test-harness.ts',
  'src/renderer/src/runtime/sync-runtime-graph-test-harness.ts'
]
const supportBridges = new Set([
  'src/renderer/src/runtime/web-runtime-browser-creation-placement-test-rig.ts',
  'src/renderer/src/components/editor/editor-model-lifetime-fixture.ts',
  // Autosave suites' store rig; it takes the editor harness's tab-layout maps.
  'src/renderer/src/components/editor/editor-autosave-controller-test-fixture.ts',
  // Closed-saving-view save suites' rig; it builds on the autosave rig above.
  'src/renderer/src/components/editor/editor-save-closed-view.test-fixture.ts',
  // Browser suites' store with main drawing their tabs; it takes the browser harness's store.
  'src/renderer/src/store/slices/browser-slice-drawn-from-main.test-fixture.ts'
])

function productConsumers(file, graph, unitFiles) {
  return [...unitConsumers([file], graph.reverse)].filter(
    (consumer) =>
      consumer !== file &&
      !unitFiles.has(consumer) &&
      !(consumer.startsWith(CROSS_VERSION_WIRE_DIR) && consumer.endsWith('.unit.test.ts')) &&
      !supportBridges.has(consumer)
  )
}

describe('unit support routing', () => {
  it.each(unitHarnesses)(
    'keeps unit checks and lint while excluding packaging for %s',
    (unitHarness) => {
      const result = classifyPrJobs([unitHarness])
      expect(result.should_run).toBe(true)
      expect(result.static_analysis).toBe(true)
      expect(result.typecheck).toBe(true)
      expect(result.test).toBe(true)
      expect(result.package).toBe(false)
      expect(result.package_windows).toBe(false)
    }
  )

  it.each(unitHarnesses)(
    'retains packaging for unknown helpers and mixed product changes with %s',
    (unitHarness) => {
      for (const file of [
        unitHarness.replace(/\.(tsx?)$/, '-next.$1'),
        'src/renderer/src/runtime/web-session-tabs-sync-next-test-harness.ts',
        'src/renderer/src/runtime/web-session-tabs-sync/snapshot-api.ts',
        'src/renderer/src/components/native-chat/NativeChatStructuredSession.next-test-harness.tsx',
        'src/renderer/src/components/native-chat/NativeChatStructuredSession.tsx',
        'src/main/providers/windows-conpty-wide-char-duplication.node-pty.test.ts',
        'src/main/browser/browser-route-webrtc-egress.electron.test.ts'
      ]) {
        const result = classifyPrJobs([unitHarness, file])
        expect(result.should_run, file).toBe(true)
        expect(result.test, file).toBe(true)
        expect(result.package, file).toBe(
          file !== 'src/main/providers/windows-conpty-wide-char-duplication.node-pty.test.ts'
        )
        expect(result.package_windows, file).toBe(true)
      }
    }
  )

  it.each(unitHarnesses)('does not select product E2E for %s', (unitHarness) => {
    expect(selectPrE2eSpecs([unitHarness])).toEqual([])
  })

  it('retains E2E selection for unknown helpers, product changes and selected specs', () => {
    const spec = 'tests/e2e/paired-client-hosted-browser-restart-survival.spec.ts'
    for (const file of [
      'src/renderer/src/runtime/web-session-tabs-sync-next-test-harness.ts',
      'src/renderer/src/runtime/web-session-tabs-sync/snapshot-api.ts',
      spec
    ]) {
      expect(selectPrE2eSpecs([harness, file]), file).toContain(spec)
    }
  })
})

describe('unit support import ownership', () => {
  let graph
  let unitFiles
  beforeAll(() => {
    graph = collectUnitDependencyGraph()
    unitFiles = new Set(discoverUnitFiles())
  }, 60_000)

  it.each(unitHarnesses)('rejects any product consumer of %s', (unitHarness) => {
    expect(graph.files.has(unitHarness)).toBe(true)
    expect(
      [...unitConsumers([unitHarness], graph.reverse)].some((file) => unitFiles.has(file))
    ).toBe(true)
    expect(productConsumers(unitHarness, graph, unitFiles)).toEqual([])
  })

  it.each(unitHarnesses)('keeps the full unit inventory for a normal PR editing %s', (file) => {
    const files = [...unitFiles]
    const plan = planUnitSelection({
      files,
      changed: [file],
      graph,
      timings: {},
      event: { pull_request: { draft: false } },
      mode: 'selected'
    })
    expect(plan.mode).toBe('shadow')
    expect(plan.executionFiles).toEqual(files)
    expect(plan.shards).toHaveLength(5)
  })

  it.each([
    "import '@/runtime/web-session-tabs-sync-test-harness'",
    "export * from '@/runtime/web-session-tabs-sync-test-harness'",
    "import('@/runtime/web-session-tabs-sync-test-harness')",
    "import type { Fixture } from '@/runtime/web-session-tabs-sync-test-harness'"
  ])('detects a product importer using %s', (source) => {
    const importer = 'src/renderer/src/runtime/product.ts'
    const test = 'src/renderer/src/runtime/ownership.test.ts'
    const synthetic = buildUnitDependencyGraph(
      new Map([
        [harness, 'export const value = 1'],
        [importer, source],
        [test, "import './web-session-tabs-sync-test-harness'"]
      ])
    )
    expect(productConsumers(harness, synthetic, new Set([test]))).toEqual([importer])
  })

  it('rejects product consumers reached through an audited support bridge', () => {
    const bridge = 'src/renderer/src/components/editor/editor-model-lifetime-fixture.ts'
    const importer = 'src/renderer/src/components/editor/product.ts'
    const synthetic = buildUnitDependencyGraph(
      new Map([
        [harness, 'export const value = 1'],
        [bridge, "import '@/runtime/web-session-tabs-sync-test-harness'"],
        [importer, "import './editor-model-lifetime-fixture'"]
      ])
    )
    expect(productConsumers(harness, synthetic, new Set())).toEqual([importer])
  })
})
