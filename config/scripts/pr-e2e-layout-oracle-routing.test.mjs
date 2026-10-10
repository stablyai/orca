import { describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { classifyE2eJobs, selectGeneralE2eSpecs } from './ci-e2e-job-selection.mjs'
import {
  hasSshSourceChange,
  PR_E2E_SOURCE_ROUTES,
  selectPrE2eSpecs,
  shouldRunReusablePrE2e
} from './pr-e2e-source-routing.mjs'

const projectDir = resolve(import.meta.dirname, '../..')

const ORACLE_ROUTE = PR_E2E_SOURCE_ROUTES.find((route) => route.id === 'workspace-layout.oracle')
const TAB_STORE_ROUTE = PR_E2E_SOURCE_ROUTES.find(
  (route) => route.id === 'workspace-layout.oracle-tab-store'
)

/** One product file per layout writer family; each alone must run the oracle. */
const LAYOUT_AUTHORITIES = [
  'src/shared/workspace-layout/workspace-layout-pane-commands.ts',
  'src/main/persistence/terminal-topology/terminal-topology-commit.ts',
  'src/main/persistence/restoring-sessions/session-owner-fields.ts',
  'src/main/persistence/loading-store/pty-binding-persistence.ts',
  'src/main/runtime/orca-runtime-split-pty-backed-terminal.ts',
  'src/main/runtime/orca-runtime-move-headless-mobile-session-tab.ts',
  'src/main/runtime/orca-runtime-create-terminal.ts',
  'src/renderer/src/runtime/mobile-session-tab-close.ts',
  'src/renderer/src/runtime/runtime-layout-client.ts',
  'tests/e2e/workspace-layout-oracle-known-on-main.ts',
  'tests/e2e/helpers/workspace-layout-oracle-compare.ts'
]

describe('workspace layout oracle PR E2E routing', () => {
  it('routes each layout authority on its own', () => {
    expect(ORACLE_ROUTE, 'the oracle route was renamed or removed').toBeDefined()
    for (const file of LAYOUT_AUTHORITIES) {
      expect(selectPrE2eSpecs([file]), file).toEqual(ORACLE_ROUTE.specs.toSorted())
      expect(shouldRunReusablePrE2e([file]), file).toBe(true)
    }
  })

  it('runs the window and headless oracles, not the SSH lane, for the tab store', () => {
    for (const file of [
      'src/renderer/src/store/slices/tabs.ts',
      'src/renderer/src/store/slices/tabs/tabs-move-actions.ts'
    ]) {
      expect(selectPrE2eSpecs([file]), file).toEqual(TAB_STORE_ROUTE.specs.toSorted())
      expect(existsSync(join(projectDir, file)), file).toBe(true)
    }
  })

  it('sends each oracle spec to the job that can run it', () => {
    const specs = ORACLE_ROUTE.specs
    // Window spec runs in the general shards; headless and SSH run in their dedicated jobs.
    expect(selectGeneralE2eSpecs(specs)).toEqual(['tests/e2e/workspace-layout-oracle.spec.ts'])
    expect(classifyE2eJobs(JSON.stringify(specs))).toEqual({
      e2e_run_changed: true,
      e2e_needs_build: true
    })
    // The SSH oracle reaches the Docker lane by spec name, not by claiming SSH source.
    expect(hasSshSourceChange(LAYOUT_AUTHORITIES)).toBe(false)
  })

  it('keeps every routed spec and authority a real file', () => {
    for (const file of [...ORACLE_ROUTE.specs, ...LAYOUT_AUTHORITIES]) {
      expect(existsSync(join(projectDir, file)), file).toBe(true)
    }
  })

  it('leaves tests, fixtures and unrelated runtime modules alone', () => {
    for (const file of [
      'src/main/persistence/terminal-topology/terminal-topology-commit.test.ts',
      'src/main/persistence/terminal-topology/terminal-leaf-move-fixture.ts',
      'src/main/runtime/orca-runtime-tests/mobile-session-tabs-part-03.spec.ts',
      'src/main/runtime/runtime-durable-store-fixture.ts',
      'src/main/runtime/orchestration/db/worker-terminal/worker-terminal-store.ts',
      'src/main/runtime/rpc/methods/terminal/terminal-create.ts',
      'src/main/runtime/runtime-rpc-database.ts',
      'src/main/runtime/orca-runtime-files.ts',
      'src/renderer/src/runtime/sync-runtime-graph.ts',
      'src/renderer/src/runtime/remote-runtime-terminal-multiplexer.ts',
      'src/renderer/src/runtime/web-session-tabs-sync-test-harness.ts',
      'tests/e2e/workspace-layout-oracle-latency.spec.ts'
    ]) {
      expect(ORACLE_ROUTE.matches(file) || TAB_STORE_ROUTE.matches(file), file).toBe(false)
    }
  })
})
