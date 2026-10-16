import type { EphemeralVmApi } from '../../shared/ephemeral-vm-api'

type HostMethod<T> = T extends (...args: infer A) => Promise<infer R>
  ? (...args: A) => R | Promise<R>
  : T
export type EphemeralVmHost = { [K in keyof EphemeralVmApi]: HostMethod<EphemeralVmApi[K]> }
let registered: EphemeralVmHost | null = null
export function registerEphemeralVmHost(host: EphemeralVmHost | null): void {
  registered = host
}
export function getEphemeralVmHost(): EphemeralVmHost {
  if (!registered) {
    throw new Error('ephemeral_vm_host_unavailable: update the owning Orca server')
  }
  return registered
}
export function hasEphemeralVmHost(): boolean {
  return registered !== null
}
