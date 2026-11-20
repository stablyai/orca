// The device store that keeps each server's last bot listing; the web build has none (kept-server-bot-store.web.ts).
import type { DeviceStore } from '../device-store/device-store-contract'

export type KeptServerBotStore = Pick<DeviceStore, 'read' | 'write'>

/** Loaded on first use, so screens that never list a server never load the native store. */
export async function keptServerBotStore(): Promise<KeptServerBotStore | null> {
  return (await import('../device-store/device-store')).processDeviceStore()
}
