import type { MemorySnapshot } from '../../shared/process-stats-types'
import type { CommandHandler } from '../dispatch'
import { formatMemorySnapshot, printResult } from '../format'
import { TERMINAL_DAEMON_HANDLERS } from './terminal-daemon'

export const DIAGNOSTICS_HANDLERS: Record<string, CommandHandler> = {
  'diagnostics memory': async ({ client, json }) => {
    const result = await client.call<MemorySnapshot>('diagnostics.memory')
    printResult(result, json, formatMemorySnapshot)
  },
  ...TERMINAL_DAEMON_HANDLERS
}
