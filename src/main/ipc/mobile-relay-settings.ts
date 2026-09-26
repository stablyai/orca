import { ipcMain } from 'electron'
import { z } from 'zod'
import type {
  SelfHostedRelaySettings,
  SelfHostedRelaySettingsResult
} from '../../shared/mobile-relay-provider'

const SettingsSchema = z
  .object({ url: z.string().max(2048), accessKey: z.string().max(256) })
  .strict()
  .nullable()

export function registerMobileRelaySettingsHandlers(
  configure?: (settings: SelfHostedRelaySettings | null) => void
): void {
  ipcMain.handle(
    'mobile:configureSelfHostedRelay',
    (event, input: unknown): SelfHostedRelaySettingsResult => {
      if (event.sender.isDestroyed() || event.sender.getType() !== 'window') {
        return { ok: false, message: 'Configure the Relay in the desktop app.' }
      }
      const parsed = SettingsSchema.safeParse(input)
      if (!parsed.success) {
        return { ok: false, message: 'Enter a Relay URL and access key.' }
      }
      if (!configure) {
        return { ok: false, message: 'Configure the Relay in the desktop app.' }
      }
      try {
        configure(parsed.data)
        return { ok: true }
      } catch (error) {
        return {
          ok: false,
          message: error instanceof Error ? error.message : 'Could not save Relay settings.'
        }
      }
    }
  )
}
