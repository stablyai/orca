import { beforeEach, describe, vi, expect, it } from 'vitest'
import { registerHeadlessCloseKeepsPublicationEpochTests } from './headless-close-keeps-publication-epoch.spec'
import { registerHeadlessTabOrderStabilityTests } from './headless-tab-order-stability.spec'
import { registerOrcaRuntimeMoveHeadlessMobileSessionTabTests } from './orca-runtime-move-headless-mobile-session-tab.spec'
import { registerOrcaRuntimeHeadlessHydrationRepoGateTests } from './orca-runtime-headless-hydration-repo-gate.spec'

const layoutOwner = vi.hoisted(() => ({ isMain: false }))
vi.mock('../../shared/layout-owner-switch', () => ({
  get ORCA_LAYOUT_OWNER_IS_MAIN() {
    return layoutOwner.isMain
  }
}))

describe.each([false, true])('layout owner on main: %s', (isMain) => {
  beforeEach(() => {
    layoutOwner.isMain = isMain
  })

  registerHeadlessCloseKeepsPublicationEpochTests()
  registerHeadlessTabOrderStabilityTests()
  registerOrcaRuntimeMoveHeadlessMobileSessionTabTests()
  registerOrcaRuntimeHeadlessHydrationRepoGateTests()
})

import { OrcaRuntimeService } from './orca-runtime'
import { partialRuntimeStore } from './runtime-store-partial-fixture'
import { MOBILE_PROJECT_SECTIONS_METHODS } from './rpc/methods/mobile-project-sections'
import { publishMobileProjectSections } from './mobile-project-sections-snapshot'
import { HEADLESS_RUNTIME_WINDOW_ID } from '../../shared/runtime-types'

it('answers only known owner input and wakes pending readers after real headless restoration', async () => {
  vi.useFakeTimers()
  const create = () =>
    new OrcaRuntimeService(
      partialRuntimeStore({
        getRepos: () => [],
        getAllWorktreeMeta: () => ({}),
        getWorktreeMeta: () => undefined,
        getSettings: () => ({ workspaceDir: '/tmp/workspaces' })
      })
    )
  const method = MOBILE_PROJECT_SECTIONS_METHODS[0]
  const read = (runtime: OrcaRuntimeService) => method.handler(undefined, { runtime })
  try {
    const desktop = create()
    expect(() => read(desktop)).toThrow('runtime_unavailable')
    desktop.attachWindow(1)
    expect(() => read(desktop)).toThrow('runtime_unavailable')
    desktop.syncWindowGraph(1, { tabs: [], leaves: [], rendererGeneration: 'first' })
    expect(() => read(desktop)).toThrow('runtime_unavailable')
    const runtime = create()
    runtime.syncWindowGraph(HEADLESS_RUNTIME_WINDOW_ID, { tabs: [], leaves: [] })
    expect(await read(runtime)).toEqual({ catalog: null })
    const wake = vi.spyOn(runtime, 'notifyReposChangedForRemoteClients')
    runtime.attachWindow(2)
    expect(() => read(runtime)).toThrow('runtime_unavailable')
    runtime.markGraphReloadFailed(2, 'renderer-process-gone')
    expect(await read(runtime)).toEqual({ catalog: null })
    expect(wake).toHaveBeenCalledTimes(1)
    // A late healthy graph from the pending promotion is still accepted, but graph-ready alone is not a catalog.
    runtime.syncWindowGraph(2, { tabs: [], leaves: [], rendererGeneration: 'late' })
    expect(() => read(runtime)).toThrow('runtime_unavailable')
    const catalog = { repos: [], projects: [], setups: [], projectOrderBy: 'manual' as const }
    expect(publishMobileProjectSections(catalog)).toBe(true)
    expect(await read(runtime)).toEqual({ catalog })
    expect(publishMobileProjectSections(structuredClone(catalog))).toBe(false)
    runtime.markRendererReloading(2)
    expect(await read(runtime)).toEqual({ catalog })
    runtime.markGraphUnavailable(2)
    expect(await read(runtime)).toEqual({ catalog })
    wake.mockRestore()
  } finally {
    vi.useRealTimers()
  }
})
