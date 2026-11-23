import { ipcMain } from 'electron'
import { isTrustedUIRenderer } from '../ui'
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
    async (event, args: unknown): Promise<EmulatorRuntimeSessionUrls> => {
      if (!isTrustedUIRenderer(event.sender)) {
        throw new Error('Emulator stream forwarding must come from the Orca window.')
      }
      const input: Record<string, unknown> =
        typeof args === 'object' && args !== null ? { ...args } : {}
      const environmentId = optionalString(input.environmentId)
      if (!environmentId) {
        throw new Error('Emulator stream forwarding requires an environment id.')
      }
      return forwardEmulatorRuntimeSession(getUserDataPath(), {
        environmentId,
        streamUrl: optionalString(input.streamUrl),
        wsUrl: optionalString(input.wsUrl)
      })
    }
  )
}
