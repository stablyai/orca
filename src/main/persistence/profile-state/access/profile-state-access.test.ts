import * as fs from 'node:fs'
import { randomUUID } from 'node:crypto'
import { tmpdir, hostname } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  acquireProfileStateMaintenance,
  acquireProfileStateRuntimeAdmission,
  type ProfileStateMaintenance
} from './profile-state-access'
import { profileStateAccessPaths } from './profile-state-access-owner'
import * as identity from './profile-state-access-identity'
import type * as processStart from '../../../daemon/endpoint/identity/daemon-process-start-time'

vi.mock('node:fs', async (importOriginal) => ({ ...(await importOriginal<typeof fs>()) }))
vi.mock('../../../daemon/endpoint/identity/daemon-process-start-time', async (importOriginal) => ({
  ...(await importOriginal<typeof processStart>())
}))
vi.mock('./profile-state-access-identity', async (importOriginal) => ({
  ...(await importOriginal<typeof identity>())
}))

const roots: string[] = []
function root(): string {
  const path = fs.mkdtempSync(join(tmpdir(), 'orca-state-access-'))
  roots.push(path)
  return path
}

beforeEach(() => {
  // Exercise rename retries without real backoff delays.
  vi.spyOn(Atomics, 'wait').mockReturnValue('timed-out')
})

afterEach(() => {
  vi.restoreAllMocks()
  for (const path of roots.splice(0)) {
    fs.rmSync(path, { recursive: true, force: true })
  }
})

function staleGate(
  path: string,
  pid = 12345,
  host = hostname(),
  extra: {
    bootIdentity?: string
    machineIdentity?: string
    startedAtMs?: number
    processStartIdentity?: string
  } = {}
): string {
  const gate = profileStateAccessPaths(path).maintenance
  fs.mkdirSync(gate)
  const token = randomUUID()
  const record = join(gate, `${token}.owner`)
  fs.writeFileSync(
    record,
    JSON.stringify({
      token,
      pid,
      host,
      platform: process.platform,
      pidNamespace: process.platform === 'linux' ? fs.readlinkSync('/proc/self/ns/pid') : null,
      machineIdentity: identity.profileStateAccessMachineIdentity(),
      ...extra
    })
  )
  return record
}

describe('profile state owner reclamation', () => {
  it('cannot remove a replacement published while it releases its own token', () => {
    const path = root()
    const original = acquireProfileStateMaintenance(path)
    const unlink = fs.unlinkSync
    let replacement: ProfileStateMaintenance | undefined
    let intercepted = false
    vi.spyOn(fs, 'unlinkSync').mockImplementation((entry) => {
      unlink(entry)
      if (!intercepted && String(entry).includes('maintenance')) {
        intercepted = true
        replacement = acquireProfileStateMaintenance(path)
      }
    })
    original.release()
    expect(replacement).toBeDefined()
    replacement?.assertActive()
    expect(() => acquireProfileStateRuntimeAdmission(path)).toThrow('in use')
    replacement?.release()
  })

  it('cannot remove a replacement published after stale-owner observation', () => {
    const path = root()
    const old = staleGate(path)
    const kill = process.kill
    vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
      if (pid === 12345) {
        throw Object.assign(new Error('exited'), { code: 'ESRCH' })
      }
      return kill(pid, signal)
    })
    const unlink = fs.unlinkSync
    let replacement: ProfileStateMaintenance | undefined
    vi.spyOn(fs, 'unlinkSync').mockImplementation((entry) => {
      unlink(entry)
      if (entry === old) {
        replacement = acquireProfileStateMaintenance(path)
      }
    })
    expect(() => acquireProfileStateMaintenance(path)).toThrow('in use')
    replacement?.assertActive()
    expect(replacement).toBeDefined()
    replacement?.release()
  })
})
