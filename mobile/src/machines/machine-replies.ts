import { readHostMethodReply } from '../host-screen/host-sidebar-feed-operations'
import type { RpcResponse } from '../transport/types'
import {
  machinesListRead,
  machineSleep,
  machineWake,
  type MobileMachine,
  type MobileMachineProvider
} from './machine-operations'

export type MachinesListOutcome =
  | { kind: 'providers'; providers: MobileMachineProvider[] }
  /** An older desktop, one with Machines off, or a server that runs no providers. */
  | { kind: 'unavailable' }
  | { kind: 'failed'; message: string }

export function readMachinesList(reply: RpcResponse): MachinesListOutcome {
  const read = readHostMethodReply(reply, machinesListRead.interpret)
  if (read.kind === 'unavailable') {
    return { kind: 'unavailable' }
  }
  if (read.kind === 'failed') {
    return { kind: 'failed', message: reply.ok ? 'Unreadable reply' : reply.error.message }
  }
  if (!read.value.ok) {
    return read.value.code === 'unsupported'
      ? { kind: 'unavailable' }
      : { kind: 'failed', message: read.value.message }
  }
  return { kind: 'providers', providers: read.value.value }
}

export type MachineActionOutcome =
  | { kind: 'done'; machine: MobileMachine }
  /** The provider answered and refused. */
  | { kind: 'failed'; message: string }
  /** No answer reached the phone: the action may still be running on the desktop. */
  | { kind: 'unverified' }

export function readMachineAction(
  reply: RpcResponse,
  verb: 'wake' | 'sleep'
): MachineActionOutcome {
  const read = readHostMethodReply(
    reply,
    verb === 'wake' ? machineWake.interpret : machineSleep.interpret
  )
  if (read.kind === 'unavailable') {
    return { kind: 'failed', message: 'This computer no longer offers machines.' }
  }
  if (read.kind === 'failed') {
    return reply.ok
      ? { kind: 'failed', message: 'This computer sent an unreadable reply.' }
      : { kind: 'unverified' }
  }
  return read.value.ok
    ? { kind: 'done', machine: read.value.value }
    : { kind: 'failed', message: read.value.message }
}
