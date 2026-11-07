import { beforeAll, describe, expect, it } from 'vitest'
import {
  buildUnitDependencyGraph,
  collectUnitDependencyGraph,
  unitConsumers
} from '../../ci/unit-selection/dependency-graph/ci-unit-dependency-graph.mjs'
import {
  CROSS_VERSION_WIRE_DIR,
  discoverUnitFiles
} from '../../ci/unit-selection/dependency-graph/ci-unit-files.mjs'

const harness =
  'src/renderer/src/runtime/web-session-tabs-sync/testing/web-session-tabs-sync.test-fixture.ts'
const structuredSessionHarness =
  'src/renderer/src/components/native-chat/NativeChatStructuredSession.test-harness.tsx'

const unitHarnesses = [
  harness,
  structuredSessionHarness,
  'src/renderer/src/store/slices/editor/editor-slice-test-harness.ts',
  'src/renderer/src/store/slices/browser/browser-slice-test-harness.ts',
  'src/renderer/src/runtime/hosted-terminals/creation/testing/web-runtime-terminal-create.test-fixture.ts',
  'src/renderer/src/runtime/sync-runtime-graph-test-harness.ts'
]
const supportBridges = new Set([
  // Launch request suites' store rig; it takes the terminal harness's workspace layout.
  'src/renderer/src/runtime/hosted-terminals/creation/agent-launch/web-runtime-agent-launch-options.test-fixture.ts',
  'src/renderer/src/runtime/web-runtime-browser-creation-placement-test-rig.ts',
  'src/renderer/src/components/editor/model-lifetime/retention/editor-model-lifetime-fixture.ts',
  // Autosave suites' store rig; it takes the editor harness's tab-layout maps.
  'src/renderer/src/components/editor/autosave/editor-autosave-controller-test-fixture.ts',
  // Closed-saving-view save suites' rig; it builds on the autosave rig above.
  'src/renderer/src/components/editor/save/queue/editor-save-closed-view.test-fixture.ts',
  // Browser suites' store with main drawing their tabs; it takes the browser harness's store.
  'src/renderer/src/store/slices/browser/browser-slice-drawn-from-main.test-fixture.ts'
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

  it.each([
    "import '@/runtime/web-session-tabs-sync/testing/web-session-tabs-sync.test-fixture'",
    "export * from '@/runtime/web-session-tabs-sync/testing/web-session-tabs-sync.test-fixture'",
    "import('@/runtime/web-session-tabs-sync/testing/web-session-tabs-sync.test-fixture')",
    "import type { Fixture } from '@/runtime/web-session-tabs-sync/testing/web-session-tabs-sync.test-fixture'"
  ])('detects a product importer using %s', (source) => {
    const importer = 'src/renderer/src/runtime/product.ts'
    const test = 'src/renderer/src/runtime/ownership.test.ts'
    const synthetic = buildUnitDependencyGraph(
      new Map([
        [harness, 'export const value = 1'],
        [importer, source],
        [test, "import './web-session-tabs-sync/testing/web-session-tabs-sync.test-fixture'"]
      ])
    )
    expect(productConsumers(harness, synthetic, new Set([test]))).toEqual([importer])
  })

  it('rejects product consumers reached through an audited support bridge', () => {
    const bridge =
      'src/renderer/src/components/editor/model-lifetime/retention/editor-model-lifetime-fixture.ts'
    const importer = 'src/renderer/src/components/editor/product.ts'
    const synthetic = buildUnitDependencyGraph(
      new Map([
        [harness, 'export const value = 1'],
        [
          bridge,
          "import '@/runtime/web-session-tabs-sync/testing/web-session-tabs-sync.test-fixture'"
        ],
        [importer, "import './model-lifetime/retention/editor-model-lifetime-fixture'"]
      ])
    )
    expect(productConsumers(harness, synthetic, new Set())).toEqual([importer])
  })
})
