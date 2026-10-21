import { beforeEach, describe, expect, it, vi } from 'vitest'

const { refreshV1, refreshV2 } = vi.hoisted(() => ({
  refreshV1: vi.fn<() => void>(),
  refreshV2: vi.fn<() => void>()
}))
vi.mock('./hook-service', () => ({
  openCodeHookService: { refreshInstalledPlugins: refreshV1 },
  openCode2HookService: { refreshInstalledPlugins: refreshV2 }
}))

import { refreshInstalledOpenCodeStatusPlugins } from './opencode-status-plugin-startup-refresh'

describe('refreshInstalledOpenCodeStatusPlugins', () => {
  beforeEach(() => {
    refreshV1.mockClear()
    refreshV2.mockClear()
  })

  it('refreshes both variants by default', () => {
    refreshInstalledOpenCodeStatusPlugins(null)
    expect(refreshV1).toHaveBeenCalledTimes(1)
    expect(refreshV2).toHaveBeenCalledTimes(1)
  })

  it('touches nothing while agent status hooks are off', () => {
    refreshInstalledOpenCodeStatusPlugins({ agentStatusHooksEnabled: false })
    expect(refreshV1).not.toHaveBeenCalled()
    expect(refreshV2).not.toHaveBeenCalled()
  })

  it('skips a disabled variant only', () => {
    refreshInstalledOpenCodeStatusPlugins({ disabledTuiAgents: ['opencode2'] })
    expect(refreshV1).toHaveBeenCalledTimes(1)
    expect(refreshV2).not.toHaveBeenCalled()
  })
})
