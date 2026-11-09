import { publishPageDeviceStore } from '../mobile-web-shell/bridge/page-device-store'

/** Grants the page a device store backed by `table`, which outlives the page as the shell's would. */
export function publishInMemoryDeviceStore(table: Map<string, string>): void {
  publishPageDeviceStore({
    available: () => true,
    read: async (_table, keys) => ({
      status: 'ok',
      values: keys.map((key) => table.get(key) ?? null)
    }),
    write: async (_table, ops) => {
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
