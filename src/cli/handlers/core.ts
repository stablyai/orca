import type { CommandHandler } from '../dispatch'
import { formatCliStatus, formatStatus, printResult } from '../format'

export const CORE_HANDLERS: Record<string, CommandHandler> = {
  open: async ({ client, json }) => {
    const result = await client.openOrca()
    printResult(result, json, formatCliStatus)
  },
  status: async ({ client, json }) => {
    const result = await client.getCliStatus()
    if (!json && !result.result.runtime.reachable) {
      process.exitCode = 1
    }
    printResult(result, json, formatStatus)
  }
}
