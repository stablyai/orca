import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  loadProjectsHomeViewSettings,
  saveProjectsHomeViewSettings,
  type ProjectsHomeViewSettings
} from '../storage/projects-home-view-settings'
import {
  useProjectsHomeViewState,
  type ProjectsHomeViewState
} from './use-projects-home-view-state'

type ProjectsHomeViewSettingsStorage = {
  DEFAULT_PROJECTS_HOME_VIEW_SETTINGS: ProjectsHomeViewSettings
  loadProjectsHomeViewSettings: typeof loadProjectsHomeViewSettings
  saveProjectsHomeViewSettings: typeof saveProjectsHomeViewSettings
}

vi.mock('../storage/projects-home-view-settings', async (importOriginal) => {
  const original = await importOriginal<ProjectsHomeViewSettingsStorage>()
  return {
    ...original,
    loadProjectsHomeViewSettings: vi.fn(),
    saveProjectsHomeViewSettings: vi.fn()
  }
})

const KEEP = '["desktop-a","local"]'
const STALE = '["desktop-b","ssh:retired"]'

describe('useProjectsHomeViewState', () => {
  let renderer: ReactTestRenderer | null = null
  let latest: ProjectsHomeViewState | null = null

  beforeEach(() => {
    renderer = null
    latest = null
    vi.mocked(loadProjectsHomeViewSettings)
      .mockReset()
      .mockResolvedValue({
        groupMode: 'repo',
        sortMode: 'recent',
        hideSleeping: false,
        hideDefaultBranch: false,
        executionHostIds: [KEEP, STALE]
      })
    vi.mocked(saveProjectsHomeViewSettings).mockReset().mockResolvedValue(undefined)
  })

  async function mount(): Promise<void> {
    function Probe(): null {
      latest = useProjectsHomeViewState()
      return null
    }
    await act(async () => {
      renderer = create(createElement(Probe))
      await Promise.resolve()
    })
  }

  it('prunes a persisted host selection that no longer has a represented row', async () => {
    await mount()

    act(() => {
      latest?.pruneExecutionHosts([{ id: KEEP, label: 'Desktop A · Local Mac', count: 1 }])
    })

    expect(latest?.settings.executionHostIds).toEqual([KEEP])
    expect(saveProjectsHomeViewSettings).toHaveBeenCalledWith(
      expect.objectContaining({ executionHostIds: [KEEP] })
    )
    act(() => renderer?.unmount())
  })
})
