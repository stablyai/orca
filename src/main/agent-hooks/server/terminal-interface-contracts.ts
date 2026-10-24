import type {
  TerminalInterfaceBinding,
  TerminalInterfaceObservation
} from '../../../shared/terminal-interface-observation'
import type { TerminalProcessInspection } from '../../../shared/terminal-process-inspection'

export type TerminalInterfaceOwner = {
  token: string
  launchToken?: string
  current: () => boolean
  mayRetire: () => Promise<boolean>
  retire: () => void
}
export type TerminalInterfaceTarget = {
  binding: TerminalInterfaceBinding
  generation: number
  launchToken: string | null
  blocked: boolean
  local: boolean
}
export type TerminalInterfaceDriver = {
  inventory: (ptyId?: string) => TerminalInterfaceTarget[]
  inspect: (
    binding: TerminalInterfaceBinding,
    steadyState: boolean
  ) => Promise<TerminalProcessInspection | null>
  changed: () => void
  dispose?: () => void
}
export type Lease = {
  driver: TerminalInterfaceDriver
  controller: AbortController
}
export type Entry = {
  target: TerminalInterfaceTarget
  observation: TerminalInterfaceObservation | null
  owner: TerminalInterfaceOwner | null
  input: number
  fence: number
  shellSince: number | null
  emptySince: number | null
  due: number
  pending: boolean
  qualified: boolean
  actual: boolean
  executionLaunchToken: string | null
  discoverUntil: number
}
export type HookBinding = Pick<TerminalInterfaceBinding, 'terminalHandle' | 'incarnationId'> & {
  generation?: number
}
