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
  signalCode?: string | null
  kill(signal?: string | number): void
}

export type BunTerminalOptions = {
  cols: number
  rows: number
  name: string
  data(terminal: BunTerminal, data: Uint8Array<ArrayBuffer>): void
  exit?(terminal: BunTerminal, exitCode: number, signal: string | null): void
  drain?(terminal: BunTerminal): void
}

export type BunRuntime = {
  Terminal: new (options: BunTerminalOptions) => BunTerminal
  spawn(
    command: string[],
    options: {
      cwd: string
      env: Record<string, string>
      terminal: BunTerminal | BunTerminalOptions
      windowsVerbatimArguments?: boolean
      onExit?(process: BunSubprocess, exitCode: number, signalCode: string | null): void
    }
  ): BunSubprocess
}

export type BunPtyProcess = pty.IPty & {
  destroy(): void
  processNameIsSpawnFile?: true
  jobRootProcessIsWrapper?: true
  shellProcessId?: number
  waitForSpawn?(): Promise<void>
  terminateOwnedTree?(): JobTerminationOutcome
  listOwnedProcessIds?(): readonly number[] | null
  signalProcess?(signal: string): void
}

export type BunPtySpawnArgs = {
  file: string
  args: string[]
  cwd: string
  env: Record<string, string>
  cols: number
  rows: number
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
