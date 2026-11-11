import { DEVICE_STORE_MAX_VALUE_LENGTH } from '../device-store/device-store-value-codec'
import { publishPageDeviceStore } from '../mobile-web-shell/bridge/page-device-store'

/** Grants the page a device store backed by `table`, which outlives the page and keeps the shell's value cap. */
export function publishInMemoryDeviceStore(table: Map<string, string>): void {
  publishPageDeviceStore({
    available: () => true,
    read: async (_table, keys) => ({
      status: 'ok',
      values: keys.map((key) => table.get(key) ?? null)
    }),
    write: async (_table, ops) => {
      // Like the shell, a value over the cap refuses the whole call.
      if (ops.some((op) => (op.value?.length ?? 0) > DEVICE_STORE_MAX_VALUE_LENGTH)) {
        return { written: false, refusal: 'too-large' }
      }
      for (const op of ops) {
        if (op.value === null) {
          table.delete(op.key)
        } else {
          table.set(op.key, op.value)
        }
      }
      return { written: true }
    }
  })
}
