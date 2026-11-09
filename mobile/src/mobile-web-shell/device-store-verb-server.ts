import type { DeviceStore } from '../device-store/device-store-contract'
import { DEVICE_STORE_MAX_VALUE_LENGTH } from '../device-store/device-store-value-codec'
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
  // Reads only as many keys as are sure to fit the reply budget, so no value is decrypted and then dropped;
  // the rest go back as deferred for the page to read again. Values are base64, so characters are reply bytes.
  const values: (string | null)[] = []
  let filled = 0
  while (values.length < call.keys.length) {
    const room = Math.floor(
      (BRIDGE_STORE_READ_REPLY_BUDGET_CHARS - filled) / DEVICE_STORE_MAX_VALUE_LENGTH
    )
    if (room === 0) {
      break
    }
    const read = await store.read(
      hostId,
      call.table,
      call.keys.slice(values.length, values.length + room)
    )
    if (read.status === 'unavailable') {
      return { refusal: 'unavailable' }
    }
    for (const value of read.values) {
      filled += value?.length ?? 0
      values.push(value)
    }
  }
  const deferred = call.keys.slice(values.length).map((_key, at) => values.length + at)
  return { values: [...values, ...deferred.map(() => null)], deferred }
}
