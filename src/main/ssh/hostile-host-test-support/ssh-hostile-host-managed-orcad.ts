/**
 * One hostile-host cell: on a fresh host, resolve the context, deploy orcad, and prove it picked
 * the cell's runtime, uploaded no other and ran no toolchain. An activated server must be live; an
 * unavailable host must fail with the classified reason the connect reports.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, posix } from 'node:path'
import { expect } from 'vitest'
import { NODE_RUNTIME_ASSETS, pinnedNodeRuntimeAsset } from '../../../shared/node-runtime-pin'
import { ORCAD_MANAGED_REMOTE_PORT } from '../../../shared/orcad-managed-runtime'
import { ORCAD_RUNTIMES_DIRNAME } from '../../../shared/orcad-artifacts'
import type { SshTarget } from '../../../shared/ssh-types'
import { readOrcadActivationRecord } from '../../managed-server/activation/orcad-activation-record-store'
import { classifyOrcadHostUnavailable } from '../../orcad/orcad-host-unavailable'
import { managedOrcadSlot } from '../../managed-server/lifecycle/orcad-managed-runtime-context'
import { orcadSlotDir, type OrcadSlotOptions } from '../orcad-recovery-slot'
import { resolveOrcadRemoteContext } from '../../managed-server/install/orcad-remote-context'
import { deployOrcad } from '../orcad-remote-deploy'
import { getMainHttpClient, setMainHttpClient } from '../../network/http-client'
import {
  orcadLivenessProbeCommand,
  parseOrcadLiveness
} from '../../managed-server/install/orcad-remote-launch'
import { execOrcadRemote } from '../../managed-server/install/orcad-remote-runtime-control'
import {
  ORCAD_PID_FILENAME,
  ORCAD_READINESS_FILENAME
} from '../../managed-server/install/orcad-remote-host-support'
import { decommissionRemoteOrcad } from '../../managed-server/install/orcad-remote-decommission'
import { quotePosixShell } from '../../../shared/shell-argument-quoting'
import {
  forbiddenToolActions,
  type HostileHostCellCore,
  type ManagedOrcadExpectation
} from './ssh-hostile-host-cells'
import { connectHostileHost } from './ssh-hostile-host-test-harness'
import { hostExec, hostExecStatus, type HostileHostTarget } from './ssh-hostile-host-test-fixture'

const EMPTY_CENSUS = { liveSessions: 0, startedSinceActivation: 0, daemonProtocolVersion: null }

export async function proveManagedOrcadCell(
  cell: HostileHostCellCore,
  target: HostileHostTarget,
  sshTarget: SshTarget
): Promise<void> {
  const expected = cell.managed
  const conn = await connectHostileHost(sshTarget)
  try {
    const context = await resolveOrcadRemoteContext(sshTarget, conn)
    expect(context.serverTarget).toBe(expected.runtime)
    const slot = managedOrcadSlot(context, ORCAD_MANAGED_REMOTE_PORT)
    const desktop = cell.desktopNoEgress ? refuseDesktopDownloads() : null
    const deploy = deployOrcad({
      ...slot,
      target: context.serverTarget,
      census: EMPTY_CENSUS,
      recountCensus: async () => EMPTY_CENSUS,
      ...(desktop ? { runtimeCacheRoot: desktop.cacheRoot } : {})
    }).finally(() => desktop?.restore())
    if (expected.outcome === 'unavailable') {
      const failure = await deploy.then(
        (deployed) => new Error(`deploy did not fail: ${JSON.stringify(deployed)}`),
        (error: unknown) => error
      )
      expect(classifyOrcadHostUnavailable(failure), String(failure)).toBe(expected.reason)
    } else {
      const deployed = await deploy
      const slotDir = orcadSlotDir(slot, deployed.fullVersion)
      await assertOnlyRuntimeUploaded(target, slotDir, expected)
      // The message carries the full reason, which toMatchObject's diff omits.
      expect(deployed, JSON.stringify(deployed)).toMatchObject({
        outcome: 'installed-and-activated'
      })
      await assertLiveThenDecommissioned(slot, slotDir, deployed.fullVersion)
    }
    if (desktop) {
      // With an empty cache and every fetch refused there was nothing to upload, so the host fetched it.
      expect(desktop.refusedUrls().length).toBeGreaterThan(0)
    }
    const toolLog = await hostExec(
      target,
      `cat ${quotePosixShell(target.forbiddenToolLog)} 2>/dev/null || true`
    )
    expect(forbiddenToolActions(toolLog)).toEqual([])
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

async function assertLiveThenDecommissioned(
  slot: OrcadSlotOptions,
  slotDir: string,
  version: string
): Promise<void> {
  const liveness = async (): Promise<string> =>
    parseOrcadLiveness(await execOrcadRemote(slot, orcadLivenessProbeCommand(slot.host, slotDir)))
  expect(await liveness()).toBe('LIVE')
  await assertOrcadRunsAtLoginUmask(slot, slotDir)
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

/**
 * #31125: orcad runs at the SSH login's umask, so the git, terminals and agents it spawns create
 * the user's files, while the readiness file holding the pairing token stays owner-only.
 * Linux only: macOS has no /proc to read another process's umask from.
 */
async function assertOrcadRunsAtLoginUmask(slot: OrcadSlotOptions, slotDir: string): Promise<void> {
  if (slot.host.os !== 'linux') {
    return
  }
  const pidFile = quotePosixShell(posix.join(slotDir, ORCAD_PID_FILENAME))
  const readiness = quotePosixShell(posix.join(slotDir, ORCAD_READINESS_FILENAME))
  const [login, daemon, readinessMode] = (
    await execOrcadRemote(
      slot,
      `umask; sed -n 's/^Umask:[[:space:]]*//p' "/proc/$(cat ${pidFile})/status"; stat -c %a ${readiness}`
    )
  )
    .trim()
    .split('\n')
    .map((line) => line.trim())
  expect(Number.parseInt(daemon ?? '', 8), `login ${login}, orcad ${daemon}`).toBe(
    Number.parseInt(login ?? '', 8)
  )
  expect(readinessMode).toBe('600')
}

/** An empty runtime cache and a refusing network on this computer, until `restore`. */
function refuseDesktopDownloads(): {
  cacheRoot: string
  refusedUrls: () => string[]
  restore: () => void
} {
  const cacheRoot = mkdtempSync(join(tmpdir(), 'orca-hostile-desktop-no-egress-'))
  const refused: string[] = []
  const previous = getMainHttpClient()
  setMainHttpClient({
    fetch: async (url) => {
      refused.push(url)
      throw new Error('net::ERR_CONNECTION_REFUSED')
    },
    proxySession: () => null
  })
  return {
    cacheRoot,
    refusedUrls: () => refused,
    restore: () => {
      setMainHttpClient(previous)
      rmSync(cacheRoot, { recursive: true, force: true })
    }
  }
}
