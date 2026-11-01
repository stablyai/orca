// Real Windows SSH host lane: invoke-windows-host-cells.ps1 supplies ORCA_RUN_SSH_WINDOWS_HOST=1 and ORCA_SSH_WINDOWS_HOST_CELL.
import { randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it, vi, type MockInstance } from 'vitest'

vi.mock('electron', () => ({ app: { getAppPath: () => process.cwd() } }))

import { SshConnection } from '../../ssh/connection/ssh-connection'
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

/** Host operations must avoid PowerShell hops regardless of sshd DefaultShell. */
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
        const idle = { liveSessions: 0, startedSinceActivation: 0, daemonProtocolVersion: null }
        const deployed = await deployOrcad({
          ...options,
          target: context.serverTarget,
          census: idle,
          recountCensus: async () => idle,
          releaseIncumbentAdmission: async () => {}
        })
        receipt.deploy = deployed
        expect(deployed.outcome).toBe('installed-and-activated')
        const slotDir = orcadSlotDir(options, deployed.fullVersion)
        const liveness = async () =>
          parseOrcadLiveness(
            await execOrcadRemote(options, orcadLivenessProbeCommand(options.host, slotDir))
          )
        expect(await liveness()).toBe('LIVE')
        // Probe the native orca launcher installed inside the managed profile.
        const cli = joinRemotePath(options.host, context.userDataDir, 'cli', 'bin', 'orca.exe')
        const status = JSON.parse(
          await execOrcadRemote(options, orcadWindowsNodeCommandLine(cli, ['status', '--json']))
        )
        receipt.cliStatus = status.result
        expect(status.result.runtime).toMatchObject({ reachable: true })
        expect(status.result.app.desktopWindowStatus).toBe('blocked')
        // This account blocks forwarding; verify the managed tunnel's stdio fallback.
        receipt.stdioBridge = await proveWindowsStdioBridge(conn, options.host, slotDir)
        expect(receipt.stdioBridge).toMatchObject({
          forwarding: 'refused',
          response: expect.stringMatching(/^HTTP\/1\.1 101/u)
        })
        const record = await readOrcadActivationRecord(options)
        receipt.decommission = await decommissionRemoteOrcad({
          ...options,
          record,
          census: { liveSessions: 0, startedSinceActivation: 0, daemonProtocolVersion: null }
        })
        // Include the refusal detail because matcher diffs omit the message.
        expect(receipt.decommission, JSON.stringify(receipt.decommission)).toMatchObject({
          outcome: 'decommissioned',
          version: deployed.fullVersion
        })
        expect(await liveness()).toBe('DEAD')
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
