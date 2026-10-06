// Design D5/D6 Windows SSH-host lane: the real client-side relay deploy against a real
// Win32-OpenSSH server on 127.0.0.1 (inbox capability or the pinned preview release), one cell
// per run. config/ci/windows-ssh-provider/invoke-pinned-relay-cells.ps1 provisions the account,
// sets DefaultShell, writes the descriptor and runs this file; ssh-windows-hosts.yml runs that.
//
// Run: ORCA_RUN_SSH_WINDOWS_HOST=1 ORCA_SSH_WINDOWS_HOST_CELL=<descriptor.json> pnpm test <this file>
import { randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getAppPath: () => process.cwd() } }))

import { ORCAD_RUNTIMES_DIRNAME } from '../../shared/orcad-artifacts'
import { RELAY_REMOTE_DIR } from './relay-protocol'
import { WINDOWS_RELAY_LAUNCH_LOG_PREFIX } from './ssh-relay-windows-launch-command'
import type { SshConnection } from './ssh-connection'
import { localHostObserver } from './ssh-hostile-host-observer'
import {
  assertCell,
  connectHostileHost,
  deployErrorText,
  deployOnce,
  exerciseLaunchedCell,
  installHostileHostAppEnvironment,
  TERMINAL_PROBES,
  type DeployAttempt
} from './ssh-hostile-host-test-harness'
import {
  auditWindowsSessionCommands,
  windowsSessionCommandViolations,
  type WindowsSessionCommandAudit
} from './ssh-session-command-audit'
import {
  readWindowsHostCellDescriptor,
  windowsHostCell,
  windowsHostSshTarget
} from './ssh-windows-host-cells'

const RUN = process.env.ORCA_RUN_SSH_WINDOWS_HOST === '1'
const CELL_TIMEOUT_MS = 20 * 60_000

describe.runIf(RUN)('SSH relay on a Windows OpenSSH host', () => {
  let cleanupAppEnvironment: (() => void) | null = null

  beforeAll(() => {
    cleanupAppEnvironment = installHostileHostAppEnvironment()
  })

  afterAll(() => {
    cleanupAppEnvironment?.()
  })

  it(
    'lands the cell the descriptor names',
    async () => {
      const descriptor = readWindowsHostCellDescriptor(process.env.ORCA_SSH_WINDOWS_HOST_CELL ?? '')
      const cell = windowsHostCell(descriptor.cell, descriptor.target)
      const observer = localHostObserver(descriptor.forbiddenToolLog)
      const sshTarget = windowsHostSshTarget(descriptor, cell, randomUUID())
      const audits: (WindowsSessionCommandAudit & { uploaded: boolean })[] = []
      const inspectDeploy = (attempt: DeployAttempt, uploaded: boolean): void => {
        const audit = auditWindowsSessionCommands(attempt.commands)
        audits.push({ ...audit, uploaded })
        const violations = windowsSessionCommandViolations(audit, { uploaded })
        expect(violations, `${cell.id}: ${violations.join('; ')}`).toEqual([])
      }
      const receipt: Record<string, unknown> = { cell: cell.id, target: descriptor.target, audits }
      // The deploy logs each relay launch; the cell reads them to prove which route ran.
      const launches: unknown[] = []
      const logSpy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
        const line = args.map(String).join(' ')
        if (line.startsWith(WINDOWS_RELAY_LAUNCH_LOG_PREFIX)) {
          launches.push(JSON.parse(line.slice(WINDOWS_RELAY_LAUNCH_LOG_PREFIX.length)))
        }
        process.stdout.write(`${line}\n`)
      })
      receipt.launches = launches
      let conn: SshConnection | null = null
      try {
        conn = await connectHostileHost(sshTarget)
        const first = await deployOnce(conn)
        Object.assign(receipt, {
          settledRung: first.settledRung,
          refusals: first.refusals,
          selfTest: first.run?.selfTest ?? null,
          runtimeTransfer: first.run?.runtimeTransfer ?? null,
          deployError: deployErrorText(first)
        })
        await assertCell(cell, observer, first)
        if (cell.expect.outcome === 'launched') {
          const evidence = await exerciseLaunchedCell({
            cell,
            observer,
            sshTarget,
            terminal: TERMINAL_PROBES.windows,
            first,
            firstConn: conn,
            inspectDeploy
          })
          Object.assign(receipt, evidence, { reused: true, gcKeptInUse: true })
          // One launch, outside sshd's job with no WMI grant; the second connect launched nothing,
          // so it adopted the relay that outlived the first SSH connection.
          expect(launches).toEqual([{ method: 'breakaway', pid: expect.any(Number), inJob: false }])
        } else {
          // Opted out: nothing may enter the pinned runtime store, whatever the host-Node path did.
          const store = `${descriptor.home}/${RELAY_REMOTE_DIR}/${ORCAD_RUNTIMES_DIRNAME}`
          expect(await observer.exists(store)).toBe(false)
          receipt.pinnedStoreUntouched = true
        }
        receipt.passed = true
      } finally {
        logSpy.mockRestore()
        await conn?.disconnect().catch(() => {})
        writeFileSync(descriptor.receipt, `${JSON.stringify(receipt, null, 2)}\n`)
      }
    },
    CELL_TIMEOUT_MS
  )
})
