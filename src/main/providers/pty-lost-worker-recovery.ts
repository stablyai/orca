import type { TerminalOscLinkRange } from '../../shared/terminal-osc-link-ranges'
import type { PtyLostWorkerRecovery } from './pty-spawn-result'
import type { PtySpawnOptions } from './types'

export type PtyColdRestoreProbe =
  | {
      kind: 'valid-snapshot'
      scrollback: string
      cwd: string
      cols?: number
      rows?: number
      oscLinks?: TerminalOscLinkRange[]
      truncated: false
    }
  | {
      kind:
        | 'meta-absent'
        | 'meta-corrupt'
        | 'meta-closed'
        | 'payload-absent'
        | 'payload-corrupt'
        | 'io-error'
    }

export type PtyPreSpawnLostWorkerHandler = (coldRestore: {
  scrollback: string
  cwd: string
  cols?: number
  rows?: number
  oscLinks?: TerminalOscLinkRange[]
  probeSibling: (sessionId: string) => PtyColdRestoreProbe
}) => Promise<PtyLostWorkerRecovery>

export type PtyPreSpawnLostWorkerOption = {
  preSpawnLostWorker?: PtyPreSpawnLostWorkerHandler
}

export type PtySpawnOptionsWithLostWorker = PtySpawnOptions & PtyPreSpawnLostWorkerOption
