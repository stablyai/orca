import { describe, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => {
  const store = { getSettings: () => ({}) }
  return {
    store,
    compose: vi.fn(
      async (
        _core: unknown,
        _deps: { store: unknown; native: { servedOrcaProfileId(): string | undefined } }
      ) => {}
    ),
    state: {
      store,
      core: {},
      activeOrcaProfile: { profile: { id: 'served-profile' } }
    }
  }
})

vi.mock('electron', () => ({
  app: { getPath: () => '/user-data', once: vi.fn(), isPackaged: false },
  nativeTheme: {},
  shell: {}
}))
vi.mock('./main-process-state', () => ({ mainProcessState: fixture.state }))
vi.mock('./linux-runtime/linux-realtime-scheduling-guard', () => ({
  refuseRealtimeSchedulingUnderZeroRtTime: async () => {}
}))
vi.mock('../core-desktop/desktop-core-composition', () => ({ composeDesktopCore: fixture.compose }))

import { initializeReadyRuntimeServices } from './main-process-ready-runtime'

describe('desktop core composition', () => {
  // Bots record link owners from this profile's account; it must be the one whose store this is.
  it("serves the startup profile's store and names that same profile", async () => {
    await initializeReadyRuntimeServices()

    const deps = fixture.compose.mock.calls[0]?.[1]
    expect(deps?.store).toBe(fixture.store)
    expect(deps?.native.servedOrcaProfileId()).toBe('served-profile')
  })
})
