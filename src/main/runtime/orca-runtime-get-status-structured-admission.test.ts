import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import type { RuntimeStatus } from '../../shared/runtime-types'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp') }
}))

function statusForStructuredNativeChatSetting(enabled: boolean): RuntimeStatus {
  const store = {
    getSettings: () => ({
      workspaceDir: '/tmp/orca-status-admission',
      nestWorkspaces: false,
      refreshLocalBaseRefOnWorktreeCreate: false,
      branchPrefix: '',
      branchPrefixCustom: '',
      experimentalStructuredNativeChat: enabled
    })
  }
  return new OrcaRuntimeService(store as never).getStatus()
}

describe('structured-chat admission in runtime status', () => {
  it('publishes an enabled admission when the host setting is on', () => {
    expect(statusForStructuredNativeChatSetting(true).structuredSessionAdmission).toEqual({
      enabled: true
    })
  })

  it('publishes a disabled admission when the host setting is off', () => {
    expect(statusForStructuredNativeChatSetting(false).structuredSessionAdmission).toEqual({
      enabled: false
    })
  })

  it('keeps the admission field optional so an older host reads as unknown', () => {
    // Typechecks only while the field stays optional; a reader that required it would break
    // against every host that predates the field.
    const olderHostStatus: RuntimeStatus = {
      runtimeId: 'older-host',
      rendererGraphEpoch: 0,
      graphStatus: 'ready',
      authoritativeWindowId: null,
      liveTabCount: 0,
      liveLeafCount: 0
    }

    expect(olderHostStatus.structuredSessionAdmission).toBeUndefined()
  })
})
