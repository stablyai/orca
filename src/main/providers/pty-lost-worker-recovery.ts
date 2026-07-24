import type { TerminalOscLinkRange } from '../../shared/terminal-osc-link-ranges'
import type { PtyLostWorkerRecovery } from './pty-spawn-result'
import type { PtySpawnOptions } from './types'

export type PtyPreSpawnLostWorkerHandler = (coldRestore: {
  scrollback: string
  cwd: string
  cols?: number
  rows?: number
  oscLinks?: TerminalOscLinkRange[]
}) => Promise<PtyLostWorkerRecovery>

export type PtyPreSpawnLostWorkerOption = {
  preSpawnLostWorker?: PtyPreSpawnLostWorkerHandler
}

export type PtySpawnOptionsWithLostWorker = PtySpawnOptions & PtyPreSpawnLostWorkerOption
