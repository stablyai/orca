import type { DaemonPtyRuntimeState } from '../daemon/providers/adapter/daemon-pty-runtime-state'
import type { IPtyProvider, PtySpawnOptions } from '../providers/pty-provider-contract'

export const admitProspectivePtySpawn = Symbol('admitProspectivePtySpawn')
const admissions = Symbol('prospectivePtySpawnAdmissions')
export type ProspectivePtySpawn = {
  current: () => boolean | Promise<boolean>
  currentSync: () => boolean
  release: () => void
  target?: IPtyProvider
  nested?: ProspectivePtySpawn
}
type ProspectiveProvider = IPtyProvider & {
  [admitProspectivePtySpawn]?: (opts: PtySpawnOptions) => Promise<ProspectivePtySpawn | null>
}
type SpawnCarrier = Pick<PtySpawnOptions, 'cols' | 'rows'> & {
  [admissions]?: Map<IPtyProvider | DaemonPtyRuntimeState, ProspectivePtySpawn>
}

export async function acquireProspectivePtySpawn(
  provider: IPtyProvider,
  opts: PtySpawnOptions
): Promise<ProspectivePtySpawn | null> {
  const prospective: ProspectiveProvider = provider
  return (await prospective[admitProspectivePtySpawn]?.(opts)) ?? null
}

export function carryProspectivePtySpawn(source: SpawnCarrier, target: SpawnCarrier): void {
  if (source[admissions]) {
    Object.assign(target, { [admissions]: source[admissions] })
  }
}

export function bindProspectivePtySpawn(
  options: SpawnCarrier,
  provider: IPtyProvider,
  receipt: ProspectivePtySpawn
): void {
  const map = options[admissions] ?? new Map()
  map.set(provider, receipt)
  Object.assign(options, { [admissions]: map })
  if (receipt.target && receipt.nested) {
    bindProspectivePtySpawn(options, receipt.target, receipt.nested)
  }
}

export async function validateProspectivePtySpawn(
  provider: IPtyProvider | DaemonPtyRuntimeState,
  options: SpawnCarrier
): Promise<ProspectivePtySpawn | undefined> {
  const receipt = options[admissions]?.get(provider)
  if (receipt && !(await receipt.current())) {
    throw new Error('Terminal spawn target changed')
  }
  return receipt
}
