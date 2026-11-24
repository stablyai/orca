import type { DevicePrincipal } from './pairing/device-principal'
import type { BotShareGrant } from './pairing/bot-share-device-store'

export type E2EEAuthenticatedDevice = DevicePrincipal & {
  // Absent for a keyed row, which never presented a bearer.
  deviceToken?: string
  // A teammate's share device: it reaches this one bot's chats and nothing else.
  botShare?: BotShareGrant
}
