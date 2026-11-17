import { app, ipcMain } from 'electron'
import type { CloudRemoteDesktopResult } from '../../shared/hosted-sandbox/cloud-remote-desktop'
import {
  cloudSandboxesByEnvironment,
  openCloudRemoteDesktop
} from '../hosted-sandbox/hosted-remote-desktop'
import type { HostedSandboxControlPlaneClient } from '../hosted-sandbox/hosted-sandbox-control-plane-client'
import {
  getRuntimePortForwardManager,
  openRuntimePortForward
} from '../runtime-port-forward/runtime-port-forward-service'

function environmentIdOf(value: unknown): string | null {
  const id =
    value && typeof value === 'object'
      ? Object.getOwnPropertyDescriptor(value, 'environmentId')?.value
      : undefined
  return typeof id === 'string' && id.length > 0 && id.length <= 256 ? id : null
}

/** Registered only when this build has an Orca Cloud control plane. */
export function registerCloudRemoteDesktopHandlers(client: HostedSandboxControlPlaneClient): void {
  ipcMain.removeHandler('ephemeralVm:cloudEnvironmentIds')
  ipcMain.removeHandler('ephemeralVm:openCloudRemoteDesktop')
  ipcMain.handle('ephemeralVm:cloudEnvironmentIds', (): string[] => [
    ...cloudSandboxesByEnvironment(app.getPath('userData')).keys()
  ])
  ipcMain.handle(
    'ephemeralVm:openCloudRemoteDesktop',
    async (_event, args: unknown): Promise<CloudRemoteDesktopResult> => {
      const environmentId = environmentIdOf(args)
      if (!environmentId) {
        return { ok: false, code: 'not_cloud' }
      }
      return openCloudRemoteDesktop(
        {
          userDataPath: app.getPath('userData'),
          client,
          openForward: openRuntimePortForward,
          isForwardLive: ({ environmentId: env, localPort, remotePort }) =>
            getRuntimePortForwardManager()
              ?.list(env)
              .some((f) => f.localPort === localPort && f.remotePort === remotePort) ?? false
        },
        environmentId
      )
    }
  )
}
