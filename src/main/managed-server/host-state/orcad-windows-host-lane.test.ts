// Managed orcad on a real Win32-OpenSSH host, one cell per DefaultShell: resolve the context
// (pinned node.exe, host script), deploy and activate, prove readiness and liveness, reach orcad
// through the stdio bridge (this account's sshd refuses forwarding), decommission through the
// instance-bound stop request, prove exit, and run a GC pass.
// config/ci/windows-ssh-provider/invoke-windows-host-cells.ps1 provisions the account and runs this
// file for `orcad-*` cells; ssh-windows-hosts.yml runs that.
//
// Run: ORCA_RUN_SSH_WINDOWS_HOST=1 ORCA_SSH_WINDOWS_HOST_CELL=<descriptor.json> pnpm test <this file>
import { randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it, vi, type MockInstance } from 'vitest'

vi.mock('electron', () => ({ app: { getAppPath: () => process.cwd() } }))

import { SshConnection } from '../../ssh/ssh-connection'
import {
  connectHostileHost,
  installHostileHostAppEnvironment
} from '../../ssh/hostile-host-test-support/ssh-hostile-host-test-harness'
import { resolveOrcadRemoteContext } from '../install/orcad-remote-context'
import { proveWindowsStdioBridge } from '../../ssh/orcad-windows-stdio-bridge-test-cell'
import { deployOrcad } from '../../ssh/orcad-remote-deploy'
import { orcadLivenessProbeCommand, parseOrcadLiveness } from '../install/orcad-remote-launch'
import { orcadSlotDir, type OrcadSlotOptions } from '../../ssh/orcad-recovery-slot'
import { decommissionRemoteOrcad } from '../install/orcad-remote-decommission'
import { readOrcadActivationRecord } from '../activation/orcad-activation-record-store'
import { gcOldOrcadVersions } from '../install/orcad-remote-gc'
import { execOrcadRemote } from '../install/orcad-remote-runtime-control'
import { orcadWindowsNodeCommandLine } from '../install/orcad-remote-windows-node'
import { joinRemotePath } from '../../ssh/ssh-remote-platform'
import {
  isWindowsOrcadCellId,
  readWindowsHostCellDescriptor,
  windowsHostSshTarget
} from '../../ssh/ssh-windows-host-cells'

const RUN = process.env.ORCA_RUN_SSH_WINDOWS_HOST === '1'
const CELL_TIMEOUT_MS = 20 * 60_000

/** Orcad's own host ops and launches: these must never take a PowerShell hop. */
function isOrcadHostCommand(command: string): boolean {
  return /orcad-host-script-[0-9a-f]{16}\.js|[\\/]orcad\.js /u.test(command)
}

describe.runIf(RUN)('managed orcad on a Windows OpenSSH host', () => {
  let cleanupAppEnvironment: (() => void) | null = null

  beforeAll(() => {
    cleanupAppEnvironment = installHostileHostAppEnvironment()
  })

  afterAll(() => {
    cleanupAppEnvironment?.()
  })

  it(
    'deploys, serves, decommissions by request and exits',
    async () => {
      const descriptor = readWindowsHostCellDescriptor(process.env.ORCA_SSH_WINDOWS_HOST_CELL ?? '')
      if (!isWindowsOrcadCellId(descriptor.cell)) {
        throw new Error(`${descriptor.cell} is not a managed orcad cell`)
      }
      const sshTarget = windowsHostSshTarget(descriptor, randomUUID())
      let exec: MockInstance<SshConnection['exec']> | null = null
      const receipt: Record<string, unknown> = { cell: descriptor.cell, target: descriptor.target }
      let conn: SshConnection | null = null
      try {
        conn = await connectHostileHost(sshTarget)
        exec = vi.spyOn(SshConnection.prototype, 'exec')
        const context = await resolveOrcadRemoteContext(sshTarget, conn)
        expect(context.host.os).toBe('win32')
        const options: OrcadSlotOptions = {
          conn,
          host: context.host,
          remoteHome: context.remoteHome,
          nodePath: 'node',
          userDataDir: context.userDataDir,
          bindHost: '127.0.0.1',
          port: 0
        }
        const deployed = await deployOrcad({
          ...options,
          target: context.serverTarget,
          census: { liveSessions: 0, startedSinceActivation: 0, daemonProtocolVersion: null }
        })
        receipt.deploy = deployed
        expect(deployed.outcome).toBe('installed-and-activated')
        const slotDir = orcadSlotDir(options, deployed.fullVersion)
        const liveness = async () =>
          parseOrcadLiveness(
            await execOrcadRemote(options, orcadLivenessProbeCommand(options.host, slotDir))
          )
        expect(await liveness()).toBe('LIVE')
        // Managed terminals' `orca`: the native launcher orcad installed in its profile.
        const cli = joinRemotePath(options.host, context.userDataDir, 'cli', 'bin', 'orca.exe')
        const status = JSON.parse(
          await execOrcadRemote(options, orcadWindowsNodeCommandLine(cli, ['status', '--json']))
        )
        receipt.cliStatus = status.result
        expect(status.result.runtime).toMatchObject({ reachable: true })
        expect(status.result.app.desktopWindowStatus).toBe('blocked')
        // The managed tunnel picks the stdio bridge on this account and reaches orcad through it.
        receipt.stdioBridge = await proveWindowsStdioBridge(conn, options.host, slotDir)
        expect(receipt.stdioBridge).toMatchObject({
          forwarding: 'refused',
          response: expect.stringMatching(/^HTTP\/1\.1 101/u)
        })
        // Decommission stops it by the instance-bound request orcad itself completes and proves.
        const record = await readOrcadActivationRecord(options)
        receipt.decommission = await decommissionRemoteOrcad({
          ...options,
          record,
          census: { liveSessions: 0, startedSinceActivation: 0, daemonProtocolVersion: null }
        })
        // The message carries the refusal code and reason, which toMatchObject's diff omits.
        expect(receipt.decommission, JSON.stringify(receipt.decommission)).toMatchObject({
          outcome: 'decommissioned',
          version: deployed.fullVersion
        })
        expect(await liveness()).toBe('DEAD')
        // A GC pass after decommission must leave the recorded previous slot in place.
        await gcOldOrcadVersions({
          conn,
          host: options.host,
          remoteHome: options.remoteHome,
          currentDirAbsPath: slotDir,
          record: await readOrcadActivationRecord(options)
        })
        expect(await liveness()).toBe('DEAD')

        const commands = exec.mock.calls.map(([command]) => String(command))
        const orcadCommands = commands.filter(isOrcadHostCommand)
        receipt.orcadCommands = orcadCommands.length
        receipt.powershellCommands = commands.filter((command) =>
          /^powershell\.exe /iu.test(command)
        ).length
        expect(orcadCommands.length).toBeGreaterThan(0)
        for (const command of orcadCommands) {
          expect(command).not.toMatch(/EncodedCommand/u)
        }
        receipt.passed = true
      } finally {
        exec?.mockRestore()
        await conn?.disconnect().catch(() => {})
        writeFileSync(descriptor.receipt, `${JSON.stringify(receipt, null, 2)}\n`)
      }
    },
    CELL_TIMEOUT_MS
  )
})
