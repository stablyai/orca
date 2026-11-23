import { ipcMain } from 'electron'
import {
  forwardEmulatorRuntimeSession,
  type EmulatorRuntimeSessionUrls
} from '../../emulator/remote/emulator-runtime-stream-forwarding'

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

export function registerEmulatorRuntimeStreamForwardHandler(getUserDataPath: () => string): void {
  ipcMain.handle(
    'emulator:forwardRuntimeSession',
    async (_event, args: unknown): Promise<EmulatorRuntimeSessionUrls> => {
      const input: Record<string, unknown> =
        typeof args === 'object' && args !== null ? { ...args } : {}
      const environmentId = optionalString(input.environmentId)
      if (!environmentId) {
        throw new Error('Emulator stream forwarding requires an environment id.')
      }
      return forwardEmulatorRuntimeSession(getUserDataPath(), {
        environmentId,
        deviceUdid: optionalString(input.deviceUdid),
        streamUrl: optionalString(input.streamUrl),
        wsUrl: optionalString(input.wsUrl)
      })
    }
  )
}
