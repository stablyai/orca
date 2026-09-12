import type * as pty from 'node-pty'
import type { JobTerminationOutcome } from '../../windows/windows-pty-job'
import type { WindowsBunPtyJob } from './windows-bun-pty-job'
import type { createWindowsBunPtyLaunch } from './windows-bun-pty-launch'

export type BunTerminal = {
  closed: boolean
  write(data: string | ArrayBufferView): number
  resize(cols: number, rows: number): void
  close(): void
}

export type BunSubprocess = {
  pid: number
  terminal: BunTerminal
  exited: Promise<number>
  kill(signal?: string | number): void
}

export type BunRuntime = {
  Terminal?: unknown
  spawn(
    command: string[],
    options: {
      cwd: string
      env: Record<string, string>
      terminal:
        | BunTerminal
        | {
            cols: number
            rows: number
            name: string
            data(terminal: BunTerminal, data: Uint8Array<ArrayBuffer>): void
            drain?(terminal: BunTerminal): void
          }
      windowsVerbatimArguments?: boolean
      onExit?(process: BunSubprocess, exitCode: number, signalCode: string | null): void
    }
  ): BunSubprocess
}

export type BunGlobal = typeof globalThis & { Bun?: BunRuntime }

export type BunPtyProcess = pty.IPty & {
  destroy(): void
  jobRootProcessIsWrapper?: true
  terminateOwnedTree?(): JobTerminationOutcome
  listOwnedProcessIds?(): readonly number[] | null
  signalProcess?(signal: string): void
}

export type SpawnBunPtyDeps = {
  platform?: NodeJS.Platform
  runtime?: BunRuntime
  assignHostJob?: () => boolean
  createJob?: (pid: number) => WindowsBunPtyJob | null
  createWindowsLaunch?: typeof createWindowsBunPtyLaunch
  readProcessTable?: () => string
  signalProcessGroup?: (pgid: number, signal: NodeJS.Signals) => void
}
