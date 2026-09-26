import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { readWindowsProcessCreationTime } from '../../windows/windows-process-table'
import {
  acquireProfileStateMaintenance,
  acquireProfileStateRuntimeAdmission
} from './profile-state-access'
import { profileStateAccessMachineIdentity } from './profile-state-access-identity'
import { profileStateAccessPaths } from './profile-state-access-owner'
import { removeTreeSync } from '../../../shared/windows-transient-lock-removal'

it.runIf(process.platform === 'win32')(
  'reclaims a previous Windows PID incarnation and retains the live owner using native identities',
  () => {
    const startedAt = readWindowsProcessCreationTime(process.pid)
    const machine = profileStateAccessMachineIdentity()
    expect(startedAt).toBeGreaterThan(0)
    expect(machine).toMatch(/^win32-machine-guid:/)
    if (startedAt === null) {
      throw new Error('Native process creation-time capability is required')
    }
    const root = mkdtempSync(join(tmpdir(), 'orca-profile-owner-native-'))
    try {
      const maintenance = profileStateAccessPaths(root).maintenance
      mkdirSync(maintenance)
      const token = randomUUID()
      const entry = join(maintenance, `${token}.owner`)
      writeFileSync(
        entry,
        JSON.stringify({
          token,
          pid: process.pid,
          host: hostname(),
          platform: 'win32',
          pidNamespace: null,
          bootIdentity: null,
          machineIdentity: machine,
          processStartIdentity: `win32-creation-ms:${startedAt - 1}`
        })
      )
      const admission = acquireProfileStateRuntimeAdmission(root)
      try {
        expect(existsSync(entry)).toBe(false)
        expect(() => acquireProfileStateMaintenance(root)).toThrow('unverifiable')
      } finally {
        admission.release()
      }
      acquireProfileStateMaintenance(root).release()
    } finally {
      removeTreeSync(root)
    }
  }
)
