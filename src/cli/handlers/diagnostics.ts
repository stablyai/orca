import type { MemorySnapshot } from '../../shared/process-stats-types'
import type { CommandHandler } from '../dispatch'
import { formatMemorySnapshot } from '../diagnostics/memory-snapshot-format'
import { printResult } from '../command-result-output'
import { TERMINAL_DAEMON_HANDLERS } from '../terminals/terminal-daemon'

export const DIAGNOSTICS_HANDLERS: Record<string, CommandHandler> = {
  'diagnostics memory': async ({ client, json }) => {
    const result = await client.call<MemorySnapshot>('diagnostics.memory')
    printResult(result, json, formatMemorySnapshot)
  },
  ...TERMINAL_DAEMON_HANDLERS
}
