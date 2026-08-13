import { describe, expect, it, vi } from 'vitest'
import type { EmulatorSessionInfo } from '../emulator/emulator-types'
import type { FolderWorkspace } from '../../shared/types'
import { OrcaRuntimeService } from './orca-runtime'

const FOLDER_WORKSPACE_ID = 'folder-workspace-1'
const FOLDER_WORKSPACE_KEY = `folder:${FOLDER_WORKSPACE_ID}`
const EMULATOR_INFO: EmulatorSessionInfo = {
  deviceUdid: 'emulator-5554',
  streamUrl: 'scrcpy://emulator-5554',
  wsUrl: '',
  streamCodec: 'h264',
  backend: 'android'
}

function makeFolderWorkspace(): FolderWorkspace {
  return {
    id: FOLDER_WORKSPACE_ID,
    projectGroupId: 'project-group-1',
    name: 'Mobile app',
    folderPath: '/tmp/mobile-app',
    linkedTask: null,
    comment: '',
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 1,
    createdAt: 1,
    updatedAt: 1
  }
}

describe('RuntimeEmulatorCommands folder workspace routing', () => {
  it.each([FOLDER_WORKSPACE_KEY, `id:${FOLDER_WORKSPACE_KEY}`])(
    'registers and publishes an attached device for selector %s',
    async (selector) => {
      const bridge = {
        acquireHelperForDevice: vi.fn(async () => ({
          info: EMULATOR_INFO,
          release: vi.fn(async () => {})
        })),
        getReusableActiveForWorktree: vi.fn(async () => null),
        registerActiveEmulator: vi.fn(),
        stopActiveForSwitch: vi.fn(async () => null)
      }
      const send = vi.fn()
      const runtime = new OrcaRuntimeService({
        getFolderWorkspaces: () => [makeFolderWorkspace()],
        getAllWorktreeMeta: () => new Map(),
        getRepo: () => null,
        getRepos: () => [],
        getSettings: () => ({
          mobileEmulatorEnabled: true,
          mobileEmulatorDefaultDeviceUdid: null,
          androidSdkPath: null
        })
      } as never)
      runtime.setEmulatorBridge(bridge as never)
      Object.assign(runtime, {
        getAuthoritativeWindow: () => ({ webContents: { send } })
      })

      await expect(
        runtime.emulatorAttach({
          device: 'emulator-5554',
          worktree: selector,
          focus: true
        })
      ).resolves.toEqual({ attached: true, info: EMULATOR_INFO })

      expect(bridge.acquireHelperForDevice).toHaveBeenCalledOnce()
      expect(bridge.registerActiveEmulator).toHaveBeenCalledWith(
        FOLDER_WORKSPACE_KEY,
        EMULATOR_INFO,
        { managed: true }
      )
      expect(send.mock.calls).toEqual([
        ['ui:emulatorAutoAttach', { worktreeId: FOLDER_WORKSPACE_KEY, info: EMULATOR_INFO }],
        ['emulator:pane-focus', { worktreeId: FOLDER_WORKSPACE_KEY }]
      ])
    }
  )

  it.each([FOLDER_WORKSPACE_KEY, `id:${FOLDER_WORKSPACE_KEY}`])(
    'cleans up an active emulator after selector %s is deleted',
    async (selector) => {
      let folderWorkspaces = [makeFolderWorkspace()]
      const shutdownActiveManagedForWorktree = vi.fn(async () => EMULATOR_INFO.deviceUdid)
      const runtime = new OrcaRuntimeService({
        getFolderWorkspaces: () => folderWorkspaces,
        getAllWorktreeMeta: () => new Map(),
        getRepo: () => null,
        getRepos: () => [],
        getSettings: () => ({ androidSdkPath: null })
      } as never)
      runtime.setEmulatorBridge({ shutdownActiveManagedForWorktree } as never)

      folderWorkspaces = []

      await expect(
        runtime.emulatorShutdown({ worktree: selector, managedOnly: true })
      ).resolves.toEqual({ ok: true, deviceUdid: EMULATOR_INFO.deviceUdid })
      expect(shutdownActiveManagedForWorktree).toHaveBeenCalledWith(FOLDER_WORKSPACE_KEY)
    }
  )

  it('cleans up an attach that finishes after its folder workspace is deleted', async () => {
    let folderWorkspaces = [makeFolderWorkspace()]
    const release = vi.fn(async () => {})
    let finishHelperStart:
      | ((lease: { info: EmulatorSessionInfo; release: typeof release }) => void)
      | undefined
    const bridge = {
      acquireHelperForDevice: vi.fn(
        () =>
          new Promise<{ info: EmulatorSessionInfo; release: typeof release }>((resolve) => {
            finishHelperStart = resolve
          })
      ),
      getReusableActiveForWorktree: vi.fn(async () => null),
      registerActiveEmulator: vi.fn(),
      shutdownActiveManagedForWorktree: vi.fn(async () => null),
      stopActiveForSwitch: vi.fn(async () => null)
    }
    const runtime = new OrcaRuntimeService({
      getFolderWorkspaces: () => folderWorkspaces,
      getAllWorktreeMeta: () => new Map(),
      getRepo: () => null,
      getRepos: () => [],
      getSettings: () => ({
        mobileEmulatorEnabled: true,
        mobileEmulatorDefaultDeviceUdid: null,
        androidSdkPath: null
      })
    } as never)
    runtime.setEmulatorBridge(bridge as never)
    Object.assign(runtime, {
      getAuthoritativeWindow: () => ({ webContents: { send: vi.fn() } })
    })

    const attach = runtime.emulatorAttach({
      device: EMULATOR_INFO.deviceUdid,
      worktree: FOLDER_WORKSPACE_KEY
    })
    await vi.waitFor(() => expect(bridge.acquireHelperForDevice).toHaveBeenCalledOnce())
    folderWorkspaces = []
    await expect(
      runtime.emulatorShutdown({ worktree: FOLDER_WORKSPACE_KEY, managedOnly: true })
    ).resolves.toEqual({ ok: true, deviceUdid: undefined })
    finishHelperStart?.({ info: EMULATOR_INFO, release })
    await expect(attach).rejects.toMatchObject({
      code: 'emulator_no_active',
      message: 'The workspace changed while the emulator was starting. Reattach the emulator.'
    })

    expect(bridge.registerActiveEmulator).not.toHaveBeenCalled()
    expect(bridge.shutdownActiveManagedForWorktree).toHaveBeenCalledWith(FOLDER_WORKSPACE_KEY)
    expect(release).toHaveBeenCalledWith({ cleanupIfUnused: true })
  })
})
