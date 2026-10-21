import { createHash } from 'node:crypto'
import { MACHINE_SSH_TARGET_ID_PREFIX } from '../../shared/execution-host'
import type { MachineAccess } from '../../shared/machine-provider-protocol'
import type { MachineRecord } from '../../shared/machine-inventory'
import { parseHostAccessLink } from '../../shared/remote-pairing-address'
import { pairingCodeSha256 } from './machine-inventory-records'
import type { SshConnectionState, SshTarget, SshTargetOwner } from '../../shared/ssh-types'

type SshAccess = Extract<MachineAccess, { kind: 'ssh' }>
type MachineOwner = Extract<SshTargetOwner, { type: 'machine' }>
type MachineTargetFields = Pick<
  SshTarget,
  'label' | 'host' | 'port' | 'username' | 'configHost' | 'jumpHost'
> & { owner: MachineOwner }

/** The SSH surface a machine connect needs; injected so tests never touch real sessions. */
export type MachineSshTargets = {
  getTarget: (id: string) => SshTarget | undefined
  ensureTarget: (id: string, fields: MachineTargetFields) => SshTarget
  updateTarget: (id: string, updates: Partial<Omit<SshTarget, 'id'>>) => SshTarget | null
  connect: (id: string) => Promise<SshConnectionState>
  disconnect: (id: string) => Promise<void>
}

export type MachineSshConnectResult = { sshTargetId: string; environmentId?: string }

/** Stable for the machine's life, so worktrees and tabs keyed to it survive endpoint changes. */
export function machineSshTargetId(providerKey: string, machineId: string): string {
  const digest = createHash('sha256').update(`${providerKey}\0${machineId}`).digest('hex')
  return `${MACHINE_SSH_TARGET_ID_PREFIX}${digest.slice(0, 20)}`
}

function targetFields(record: MachineRecord, access: SshAccess, id: string): MachineTargetFields {
  return {
    label: record.name,
    host: access.host,
    port: access.port,
    username: access.user,
    configHost: access.configHost ?? access.host,
    jumpHost: access.jumpHost,
    owner: {
      type: 'machine',
      runtimeId: id,
      providerKey: record.providerKey,
      machineId: record.id,
      ...(access.hostKeyFingerprints ? { hostKeyFingerprints: access.hostKeyFingerprints } : {}),
      ...(access.hostKeys ? { hostKeys: access.hostKeys } : {})
    }
  }
}

/** Whether a fresh provider answer moved the machine, so a failed connect is worth one retry. */
export function machineEndpointChanged(
  before: MachineAccess | undefined,
  after: MachineAccess | undefined
): boolean {
  return JSON.stringify(before ?? null) !== JSON.stringify(after ?? null)
}

function endpointChanged(target: SshTarget, fields: MachineTargetFields): boolean {
  return (
    target.host !== fields.host ||
    target.port !== fields.port ||
    target.username !== fields.username ||
    (target.configHost ?? target.host) !== fields.configHost ||
    target.jumpHost !== fields.jumpHost
  )
}

function pinnedKeysChanged(target: SshTarget, owner: MachineOwner): boolean {
  const current = target.owner?.type === 'machine' ? target.owner : undefined
  return (
    JSON.stringify([current?.hostKeyFingerprints ?? [], current?.hostKeys ?? []]) !==
    JSON.stringify([owner.hostKeyFingerprints ?? [], owner.hostKeys ?? []])
  )
}

/**
 * Connects a running machine's SSH access. A failed connect never removes the target: sshd may
 * still be starting after a wake, and worktrees are keyed to the target id.
 */
export async function connectMachineSsh(
  targets: MachineSshTargets,
  record: MachineRecord,
  access: SshAccess
): Promise<MachineSshConnectResult> {
  const id = machineSshTargetId(record.providerKey, record.id)
  const fields = targetFields(record, access, id)
  const existing = targets.getTarget(id)
  if (!existing) {
    targets.ensureTarget(id, fields)
  } else if (endpointChanged(existing, fields)) {
    // Disconnect first so no live session keeps talking to the old endpoint; updateTarget then
    // drops the stale runtime resolution for the new host.
    await targets.disconnect(id)
    targets.updateTarget(id, fields)
  } else if (pinnedKeysChanged(existing, fields.owner) || existing.label !== fields.label) {
    targets.updateTarget(id, { label: fields.label, owner: fields.owner })
  }
  const state = await targets.connect(id)
  if (state.status !== 'connected') {
    throw new Error(state.error || `SSH did not connect: ${state.status}`)
  }
  return {
    sshTargetId: id,
    ...(state.managedServer?.kind === 'managed'
      ? { environmentId: state.managedServer.environmentId }
      : {})
  }
}

type OrcaServerAccess = Extract<MachineAccess, { kind: 'orca-server' }>

type MachinePairingResult =
  | { ok: true; environment: { id: string } }
  | { ok: false; kind: string; message: string }

/** Pairing calls a machine connect needs; injected so tests never reach a real server. */
export type MachinePairing = {
  add: (args: { name: string; pairingCode: string }) => Promise<MachinePairingResult>
  repair: (args: { selector: string; pairingCode: string }) => Promise<MachinePairingResult>
}

/**
 * Pairs a machine's Orca server. Provider-supplied links never reach this device or the LAN, and a
 * new link re-pairs the same environment only when the server keeps its identity key.
 */
export async function connectMachineOrcaServer(
  pairing: MachinePairing,
  record: MachineRecord,
  access: OrcaServerAccess,
  previousPairingCodeSha256: string | undefined
): Promise<{ runtimeEnvironmentId: string }> {
  const link = parseHostAccessLink(access.pairingCode)
  if (!link.ok) {
    throw new Error(`${record.name} sent an invalid pairing link.`)
  }
  if (link.value.endpointKind === 'loopback' || link.value.endpointKind === 'lan') {
    throw new Error(`${record.name} sent a pairing link for a local-network address.`)
  }
  if (
    record.runtimeEnvironmentId &&
    previousPairingCodeSha256 === pairingCodeSha256(access.pairingCode)
  ) {
    return { runtimeEnvironmentId: record.runtimeEnvironmentId }
  }
  const result = record.runtimeEnvironmentId
    ? await pairing.repair({
        selector: record.runtimeEnvironmentId,
        pairingCode: access.pairingCode
      })
    : await pairing.add({ name: record.name, pairingCode: access.pairingCode })
  if (!result.ok) {
    throw new Error(
      result.kind === 'different-server'
        ? "This machine's Orca server identity changed."
        : result.message
    )
  }
  return { runtimeEnvironmentId: result.environment.id }
}
