import { describe, expect, it, vi } from 'vitest'
import type { EmulatorSessionInfo } from '../emulator/emulator-types'
import type { FolderWorkspace } from '../../shared/folder-workspaces/folder-workspace-types'
import { OrcaRuntimeService } from './orca-runtime'

export function registerOrcaRuntimeEmulatorFolderWorkspaceTests(): void {
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
}
