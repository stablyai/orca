import type { DeviceStore } from '../device-store/device-store'
import {
  BRIDGE_STORE_READ_REPLY_BUDGET_CHARS,
  storeParamsSchema,
  type BridgeStoreReadResult,
  type BridgeStoreWriteResult
} from './bridge/bridge-store-verb'

// The host comes from the shell screen, never from params: it is the only fence between hosts' values.
export async function serveDeviceStoreVerb(
  store: DeviceStore,
  hostId: string,
  params: unknown
): Promise<BridgeStoreReadResult | BridgeStoreWriteResult> {
  const call = storeParamsSchema.parse(params)
  if (call.action === 'write') {
    return store.write(hostId, call.table, call.ops)
  }
  const read = await store.read(hostId, call.table, call.keys)
  if (read.status === 'unavailable') {
    return { refusal: 'unavailable' }
  }
  // Values are base64, so characters are reply bytes.
  let filled = 0
  const deferred: number[] = []
  const values = read.values.map((value, at) => {
    if (value === null || filled + value.length <= BRIDGE_STORE_READ_REPLY_BUDGET_CHARS) {
      filled += value?.length ?? 0
      return value
    }
    deferred.push(at)
    return null
  })
  return { values, deferred }
}
