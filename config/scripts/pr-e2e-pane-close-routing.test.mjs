import { describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  hasSshSourceChange,
  PR_E2E_SOURCE_ROUTES,
  selectPrE2eSpecs,
  shouldRunReusablePrE2e
} from './pr-e2e-source-routing.mjs'

const projectDir = resolve(import.meta.dirname, '../..')

/**
 * The product paths of #21005, "retire captured remote handles when pending panes close". It
 * changed the pane close and retirement lifecycle across three transports and matched no route
 * at all, so it merged with E2E skipped outright. The routes named every module that BINDS a
 * pane and none that unbinds one.
 */
const PENDING_PANE_CLOSE_CHANGE = [
  'src/renderer/src/components/terminal-pane/retire-unbound-ipc-terminal-pane.ts',
  'src/renderer/src/components/terminal-pane/retire-unbound-runtime-terminal-pane.ts',
  'src/renderer/src/components/terminal-pane/terminal-pane-close-admission.ts',
  'src/renderer/src/components/terminal-pane/terminal-pane-retirement-ownership.ts',
  'src/renderer/src/components/terminal-pane/use-terminal-pane-close-actions.ts',
  'src/renderer/src/store/terminals/terminal-tab-close-providers.ts'
]

const CLOSE_ROUTE = PR_E2E_SOURCE_ROUTES.find(
  (route) => route.id === 'terminal-pane.close-and-retirement'
)

describe('pane close and retirement PR E2E routing', () => {
  it('selects the close specs for a pane close lifecycle change', () => {
    expect(selectPrE2eSpecs(PENDING_PANE_CLOSE_CHANGE)).toEqual([
      'tests/e2e/paired-remote-split-pane-host-retired-ghost.spec.ts',
      'tests/e2e/terminal-pane-close-layout-consistency.spec.ts',
      'tests/e2e/terminal-parked-close-retirement.spec.ts'
    ])
    expect(shouldRunReusablePrE2e(PENDING_PANE_CLOSE_CHANGE)).toBe(true)
  })

  it('routes each unbind authority on its own, not just as a group', () => {
    expect(CLOSE_ROUTE, 'the close route was renamed or removed').toBeDefined()
    // A single-file change is the shape that slipped through; assert per path rather than only
    // on the union, where one matching path would hide five that do not.
    for (const file of PENDING_PANE_CLOSE_CHANGE) {
      expect(selectPrE2eSpecs([file]), file).toEqual(CLOSE_ROUTE.specs.toSorted())
    }
  })

  it('keeps every routed spec and authority a real file', () => {
    for (const spec of CLOSE_ROUTE.specs) {
      expect(existsSync(join(projectDir, spec)), spec).toBe(true)
    }
    for (const file of PENDING_PANE_CLOSE_CHANGE) {
      expect(existsSync(join(projectDir, file)), file).toBe(true)
    }
  })

  it('leaves the Docker SSH lane and unrelated changes alone', () => {
    // The lane costs a Docker relay per run. Close changes reach SSH only through the shared
    // provider, which the non-Docker specs above already cover.
    expect(hasSshSourceChange(PENDING_PANE_CLOSE_CHANGE)).toBe(false)
    // Neighbours in the same directories that this route must not claim.
    for (const file of [
      'src/renderer/src/components/terminal-pane/CloseTerminalDialog.tsx',
      'src/renderer/src/components/terminal-pane/terminal-hidden-view-parking.ts',
      'src/renderer/src/runtime/runtime-rpc-client.ts',
      'src/renderer/src/store/terminals/terminal-tab-close-providers.test.ts'
    ]) {
      expect(CLOSE_ROUTE.matches(file), file).toBe(false)
    }
  })
})
