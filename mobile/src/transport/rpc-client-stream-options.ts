import type { ConnectionState } from './types'

export type StreamRegistryOptions = {
  nextId: () => string
  deviceToken: string
  getState: () => ConnectionState
  sendEncrypted: (request: unknown) => boolean
  sendBinary?: (bytes: Uint8Array) => boolean
}
