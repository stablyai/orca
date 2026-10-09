/**
 * The managed-orcad half of a hostile-host cell: on a fresh host, resolve the context, deploy
 * orcad, and prove it picked the cell's runtime and uploaded no other. An activated server must
 * be live; a refused one must be classified as unable to run, so the relay that follows runs the
 * pinned ladder and lands on the cell's rung.
 */
import { posix } from 'node:path'
import { expect } from 'vitest'
import { NODE_RUNTIME_ASSETS, pinnedNodeRuntimeAsset } from '../../shared/node-runtime-pin'
import { ORCAD_MANAGED_REMOTE_PORT } from '../../shared/orcad-managed-runtime'
import { ORCAD_RUNTIMES_DIRNAME } from '../../shared/orcad-artifacts'
import type { SshTarget } from '../../shared/ssh-types'
import { readOrcadActivationRecord } from './orcad-activation-record-store'
import { classifyOrcadHostUnavailable } from './orcad-host-unavailable'
import { managedOrcadSlot } from './orcad-managed-runtime-context'
import { orcadSlotDir, type OrcadSlotOptions } from './orcad-recovery-slot'
import { resolveOrcadRemoteContext } from './orcad-remote-context'
import { deployOrcad } from './orcad-remote-deploy'
import { orcadLivenessProbeCommand, parseOrcadLiveness } from './orcad-remote-launch'
import { execOrcadRemote } from './orcad-remote-runtime-control'
import { decommissionRemoteOrcad } from './orcad-remote-decommission'
import type { HostileHostCellCore, ManagedOrcadExpectation } from './ssh-hostile-host-cells'
import { connectHostileHost, deployOnce } from './ssh-hostile-host-test-harness'
import { hostExecStatus, type HostileHostTarget } from './ssh-hostile-host-test-fixture'

const EMPTY_CENSUS = { liveSessions: 0, startedSinceActivation: 0, daemonProtocolVersion: null }

export async function proveManagedOrcadCell(
  cell: HostileHostCellCore,
  target: HostileHostTarget,
  sshTarget: SshTarget
): Promise<void> {
  const expected = cell.managed
  if (!expected) {
    throw new Error(`${cell.id} names no managed expectation`)
  }
  const conn = await connectHostileHost(sshTarget)
  try {
    const context = await resolveOrcadRemoteContext(sshTarget, conn)
    expect(context.serverTarget).toBe(expected.runtime)
    const slot = managedOrcadSlot(context, ORCAD_MANAGED_REMOTE_PORT)
    const deployed = await deployOrcad({
      ...slot,
      target: context.serverTarget,
      census: EMPTY_CENSUS
    })
    const slotDir = orcadSlotDir(slot, deployed.fullVersion)
    await assertOnlyRuntimeUploaded(target, slotDir, expected)
    if (expected.outcome === 'refused') {
      // The message carries the full reason, which toMatchObject's diff omits.
      expect(deployed, JSON.stringify(deployed)).toMatchObject({
        outcome: 'installed-not-activated',
        code: expected.code
      })
      expect(classifyOrcadHostUnavailable(deployed)).toBe('native_preflight')
      await assertRelayFallback(sshTarget, expected.relayRung)
      return
    }
    expect(deployed, JSON.stringify(deployed)).toMatchObject({ outcome: 'installed-and-activated' })
    await assertLiveThenDecommissioned(slot, slotDir, deployed.fullVersion)
  } finally {
    await conn.disconnect().catch(() => {})
  }
}

/** A default runtime beside the expected one is the wrong upload this cell guards against. */
async function assertOnlyRuntimeUploaded(
  target: HostileHostTarget,
  slotDir: string,
  expected: ManagedOrcadExpectation
): Promise<void> {
  const runtimes = posix.join(posix.dirname(slotDir), ORCAD_RUNTIMES_DIRNAME)
  const runtimeDir = (sha: string): string => posix.join(runtimes, `node-${sha}`)
  const { executableSha256 } = pinnedNodeRuntimeAsset(expected.runtime)
  expect(await hostExecStatus(target, `test -x '${runtimeDir(executableSha256)}/bin/node'`)).toBe(0)
  for (const asset of Object.values(NODE_RUNTIME_ASSETS)) {
    if (asset.executableSha256 !== executableSha256) {
      expect(
        await hostExecStatus(target, `test -e '${runtimeDir(asset.executableSha256)}'`)
      ).not.toBe(0)
    }
  }
}

/** The connect's next step: no runtime setting, but orcad recorded unable to run on this host. */
async function assertRelayFallback(sshTarget: SshTarget, rung: 'A' | 'B'): Promise<void> {
  const { remoteRuntime: _setting, ...withoutSetting } = sshTarget
  const conn = await connectHostileHost({
    ...withoutSetting,
    managedServerUnavailable: { reason: 'native_preflight', appVersion: 'hostile-hosts' }
  })
  try {
    const attempt = await deployOnce(conn)
    expect(attempt.error).toBeNull()
    expect(attempt.settledRung).toBe(rung)
  } finally {
    await conn.disconnect().catch(() => {})
  }
}

async function assertLiveThenDecommissioned(
  slot: OrcadSlotOptions,
  slotDir: string,
  version: string
): Promise<void> {
  const liveness = async (): Promise<string> =>
    parseOrcadLiveness(await execOrcadRemote(slot, orcadLivenessProbeCommand(slot.host, slotDir)))
  expect(await liveness()).toBe('LIVE')
  const decommission = await decommissionRemoteOrcad({
    ...slot,
    record: await readOrcadActivationRecord(slot),
    census: EMPTY_CENSUS
  })
  expect(decommission, JSON.stringify(decommission)).toMatchObject({
    outcome: 'decommissioned',
    version
  })
  expect(await liveness()).toBe('DEAD')
}
