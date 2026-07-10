import type { MemorySnapshot } from '../../shared/types'
import type { CommandHandler } from '../dispatch'
import { formatMemorySnapshot, printResult } from '../format'

export const DIAGNOSTICS_HANDLERS: Record<string, CommandHandler> = {
  'diagnostics memory': async ({ client, json }) => {
    const result = await client.call<MemorySnapshot>('diagnostics.memory')
    printResult(result, json, formatMemorySnapshot)
  }
}
