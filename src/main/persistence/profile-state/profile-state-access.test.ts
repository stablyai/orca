import * as fs from 'node:fs'
import { randomUUID } from 'node:crypto'
import { tmpdir, hostname } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  acquireProfileStateMaintenance,
  acquireProfileStateRuntimeAdmission,
  assertProfileStateMaintenance,
  type ProfileStateMaintenance
} from './profile-state-access'
import { profileStateAccessPaths, reclaimExitedOwner } from './profile-state-access-owner'
import * as identity from './profile-state-access-identity'
import * as processStart from '../../daemon/daemon-process-start-time'

vi.mock('node:fs', async (importOriginal) => ({ ...(await importOriginal<typeof fs>()) }))
vi.mock('../../daemon/daemon-process-start-time', async (importOriginal) => ({
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

afterEach(() => {
  vi.restoreAllMocks()
  for (const path of roots.splice(0)) {
    fs.rmSync(path, { recursive: true, force: true })
  }
})

describe('profile state admission and maintenance', () => {
  it.skipIf(process.platform === 'win32')(
    'releases its published owner when directory sync fails',
    () => {
      const path = root()
      const syncFile = fs.fsyncSync
      let syncCount = 0
      const sync = vi.spyOn(fs, 'fsyncSync').mockImplementation((fd) => {
        if (++syncCount === 3) {
          throw new Error('directory sync failed')
        }
        syncFile(fd)
      })
      expect(() => acquireProfileStateRuntimeAdmission(path)).toThrow('directory sync failed')
      const paths = profileStateAccessPaths(path)
      expect(fs.readdirSync(paths.participants)).toEqual([])
      expect(fs.readdirSync(paths.candidates)).toEqual([])
      sync.mockRestore()
      acquireProfileStateMaintenance(path).release()
    }
  )

  it('does not publish an owner whose contents could not be synced', () => {
    const path = root()
    const sync = vi.spyOn(fs, 'fsyncSync').mockImplementationOnce(() => {
      throw new Error('owner sync failed')
    })
    expect(() => acquireProfileStateRuntimeAdmission(path)).toThrow('owner sync failed')
    const paths = profileStateAccessPaths(path)
    expect(fs.readdirSync(paths.participants)).toEqual([])
    expect(fs.readdirSync(paths.candidates)).toEqual([])
    sync.mockRestore()
    acquireProfileStateMaintenance(path).release()
  })

  it('allows concurrent normal writers and refuses maintenance until every admission releases', () => {
    const path = root()
    const first = acquireProfileStateRuntimeAdmission(path)
    const second = acquireProfileStateRuntimeAdmission(path)
    expect(() => acquireProfileStateMaintenance(path)).toThrow('in use')
    first.release()
    expect(() => acquireProfileStateMaintenance(path)).toThrow('in use')
    second.release()
    const maintenance = acquireProfileStateMaintenance(path)
    expect(() => acquireProfileStateRuntimeAdmission(path)).toThrow('in use')
    expect(() => acquireProfileStateMaintenance(path)).toThrow('in use')
    maintenance.release()
    acquireProfileStateRuntimeAdmission(path).release()
  })

  it('refuses a runtime publishing after maintenance has acquired and scanned', () => {
    const path = root()
    const rename = fs.renameSync
    let maintenance: ProfileStateMaintenance | undefined
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (String(to).includes('participants')) {
        maintenance = acquireProfileStateMaintenance(path)
      }
      rename(from, to)
    })
    expect(() => acquireProfileStateRuntimeAdmission(path)).toThrow('in use')
    expect(maintenance).toBeDefined()
    maintenance?.release()
    expect(fs.readdirSync(profileStateAccessPaths(path).participants)).toEqual([])
  })

  it('refuses maintenance when runtime publication precedes its final admission check', () => {
    const path = root()
    const rename = fs.renameSync
    let refused = false
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      rename(from, to)
      if (String(to).includes('participants')) {
        expect(() => acquireProfileStateMaintenance(path)).toThrow('in use')
        refused = true
      }
    })
    const admission = acquireProfileStateRuntimeAdmission(path)
    expect(refused).toBe(true)
    admission.release()
  })

  it('rejects released and fabricated maintenance owners and binds valid owners to exact profile paths', () => {
    const path = root()
    const other = root()
    const profileId = 'profile-test'
    const profileDir = join(path, 'profiles', profileId)
    fs.mkdirSync(profileDir, { recursive: true })
    const files = {
      profileId,
      dataFile: join(profileDir, 'orca-data.json'),
      databasePath: join(profileDir, 'profile-state.db')
    }
    const owner = acquireProfileStateMaintenance(path)
    assertProfileStateMaintenance(owner, files)
    expect(() => assertProfileStateMaintenance({ ...owner }, files)).toThrow('acquired')
    const wrong = acquireProfileStateMaintenance(other)
    expect(() => assertProfileStateMaintenance(wrong, files)).toThrow('paths')
    expect(() =>
      assertProfileStateMaintenance(owner, { ...files, profileId: '../escape' })
    ).toThrow('acquired')
    owner.release()
    expect(() => assertProfileStateMaintenance(owner, files)).toThrow('released')
    wrong.release()
  })

  it.skipIf(process.platform === 'win32')(
    'refuses symlinked profile directories outside the protected root',
    () => {
      const path = root()
      const outside = root()
      fs.mkdirSync(join(path, 'profiles'))
      fs.symlinkSync(outside, join(path, 'profiles', 'escaped'))
      const owner = acquireProfileStateMaintenance(path)
      expect(() =>
        assertProfileStateMaintenance(owner, {
          profileId: 'escaped',
          dataFile: join(outside, 'orca-data.json'),
          databasePath: join(outside, 'profile-state.db')
        })
      ).toThrow('paths')
      owner.release()
    }
  )

  it.each(['', '../outside', 'x'.repeat(129)])(
    'rejects invalid recovery profile IDs: %s',
    (profileId) => {
      const path = root()
      const owner = acquireProfileStateMaintenance(path)
      expect(() => owner.assertProfile(profileId, path, path)).toThrow('acquired')
      owner.release()
      acquireProfileStateRuntimeAdmission(path).release()
    }
  )
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
      ...extra
    })
  )
  return record
}

describe('profile state owner reclamation', () => {
  it('reclaims a local owner from a previous boot even when its PID is now live', () => {
    const path = root()
    vi.spyOn(identity, 'profileStateAccessBootIdentity').mockReturnValue('current-boot')
    vi.spyOn(identity, 'profileStateAccessMachineIdentity').mockReturnValue('same-machine')
    const owner = staleGate(path, process.pid, hostname(), {
      bootIdentity: 'previous-boot',
      machineIdentity: 'same-machine'
    })
    const kill = vi.spyOn(process, 'kill')
    acquireProfileStateMaintenance(path).release()
    expect(kill).not.toHaveBeenCalled()
    expect(fs.existsSync(owner)).toBe(false)
  })

  it('keeps a differently booted machine with the same hostname unverifiable', () => {
    const path = root()
    vi.spyOn(identity, 'profileStateAccessBootIdentity').mockReturnValue('current-boot')
    vi.spyOn(identity, 'profileStateAccessMachineIdentity').mockReturnValue('this-machine')
    const owner = staleGate(path, process.pid, hostname(), {
      bootIdentity: 'another-boot',
      machineIdentity: 'another-machine'
    })
    const kill = vi.spyOn(process, 'kill')
    expect(() => acquireProfileStateMaintenance(path)).toThrow('unverifiable')
    expect(kill).not.toHaveBeenCalled()
    expect(fs.existsSync(owner)).toBe(true)
  })

  it.each(['current-boot', null])(
    'does not reclaim another host with a cloned machine identity (current boot: %s)',
    (currentBoot) => {
      const path = root()
      vi.spyOn(identity, 'profileStateAccessBootIdentity').mockReturnValue(currentBoot)
      vi.spyOn(identity, 'profileStateAccessMachineIdentity').mockReturnValue('cloned-machine')
      const owner = staleGate(path, 12345, 'another-host', {
        bootIdentity: 'another-boot',
        machineIdentity: 'cloned-machine'
      })
      const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
        throw Object.assign(new Error('absent on this host'), { code: 'ESRCH' })
      })
      expect(() => acquireProfileStateMaintenance(path)).toThrow('unverifiable')
      expect(kill).not.toHaveBeenCalled()
      expect(fs.existsSync(owner)).toBe(true)
    }
  )

  it('reclaims a reused PID only when its recorded process start differs on the same boot', () => {
    const path = root()
    vi.spyOn(identity, 'profileStateAccessBootIdentity').mockReturnValue('same-boot')
    vi.spyOn(identity, 'profileStateAccessProcessIdentity').mockReturnValue(
      'linux-start-ticks:2000'
    )
    const owner = staleGate(path, process.pid, hostname(), {
      bootIdentity: 'same-boot',
      processStartIdentity: 'linux-start-ticks:1000'
    })
    acquireProfileStateMaintenance(path).release()
    expect(fs.existsSync(owner)).toBe(false)
  })

  it('cannot reclaim a live Linux owner when wall-clock time changes', () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')
    if (!platform) {
      throw new Error('Missing platform descriptor')
    }
    const path = root()
    const read = fs.readFileSync
    const fields = Array.from({ length: 20 }, () => '0')
    fields[0] = 'S'
    fields[19] = '987654'
    let clock = 1_700_000_000_000
    const wallStart = vi
      .spyOn(processStart, 'getProcessStartedAtMs')
      .mockImplementation(() => clock)
    vi.spyOn(fs, 'readFileSync').mockImplementation((file, options) => {
      if (file === '/proc/12345/stat') {
        return `12345 (orca daemon) ${fields.join(' ')}`
      }
      return read(file, options)
    })
    vi.spyOn(fs, 'readlinkSync').mockReturnValue('pid:[same-namespace]')
    vi.spyOn(identity, 'profileStateAccessBootIdentity').mockReturnValue('same-boot')
    vi.spyOn(process, 'kill').mockReturnValue(true)
    try {
      Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' })
      const processStartIdentity = identity.profileStateAccessProcessIdentity(12345)
      expect(processStartIdentity).toBe('linux-start-ticks:987654')
      if (processStartIdentity === null) {
        throw new Error('Expected process identity')
      }
      const owner = staleGate(path, 12345, hostname(), {
        bootIdentity: 'same-boot',
        processStartIdentity
      })
      clock += 60_000
      // Linux identity emulation must not change the host filesystem's publication/fsync flags.
      expect(() => reclaimExitedOwner(profileStateAccessPaths(path).maintenance)).toThrow(
        'unverifiable'
      )
      expect(fs.existsSync(owner)).toBe(true)
      expect(wallStart).not.toHaveBeenCalled()
    } finally {
      Object.defineProperty(process, 'platform', platform)
    }
  })

  it('does not compare legacy epoch timestamps with raw process identity', () => {
    const path = root()
    vi.spyOn(identity, 'profileStateAccessBootIdentity').mockReturnValue('same-boot')
    vi.spyOn(identity, 'profileStateAccessProcessIdentity').mockReturnValue(
      'linux-start-ticks:2000'
    )
    const owner = staleGate(path, process.pid, hostname(), {
      bootIdentity: 'same-boot',
      startedAtMs: 1000
    })
    expect(() => acquireProfileStateMaintenance(path)).toThrow('unverifiable')
    expect(fs.existsSync(owner)).toBe(true)
  })

  it.each([
    'wall-time-ms:1000',
    'linux-start-ticks:invalid',
    'linux-start-ticks:99999999999999999'
  ])('does not compare incompatible or malformed identity %s', (recorded) => {
    const path = root()
    vi.spyOn(identity, 'profileStateAccessBootIdentity').mockReturnValue('same-boot')
    vi.spyOn(identity, 'profileStateAccessProcessIdentity').mockReturnValue(
      'linux-start-ticks:2000'
    )
    const owner = staleGate(path, process.pid, hostname(), {
      bootIdentity: 'same-boot',
      processStartIdentity: recorded
    })
    expect(() => acquireProfileStateMaintenance(path)).toThrow('unverifiable')
    expect(fs.existsSync(owner)).toBe(true)
  })

  it('does not interpret an unavailable process start as proof of PID reuse', () => {
    const path = root()
    vi.spyOn(identity, 'profileStateAccessBootIdentity').mockReturnValue('same-boot')
    vi.spyOn(identity, 'profileStateAccessProcessIdentity').mockReturnValue(null)
    const owner = staleGate(path, process.pid, hostname(), {
      bootIdentity: 'same-boot',
      processStartIdentity: 'linux-start-ticks:1000'
    })
    expect(() => acquireProfileStateMaintenance(path)).toThrow('unverifiable')
    expect(fs.existsSync(owner)).toBe(true)
  })

  it.each([
    ['darwin-utc-start-ms:100000', 'darwin-utc-start-ms:101000', false],
    ['darwin-utc-start-ms:100000', 'darwin-utc-start-ms:101501', true],
    ['wall-time-ms:100000', 'darwin-utc-start-ms:3700000', false]
  ] as const)('compares macOS start identities safely: %s / %s', (recorded, actual, exited) => {
    const path = root()
    vi.spyOn(identity, 'profileStateAccessBootIdentity').mockReturnValue('same-boot')
    vi.spyOn(identity, 'profileStateAccessProcessIdentity').mockReturnValue(actual)
    const owner = staleGate(path, process.pid, hostname(), {
      bootIdentity: 'same-boot',
      processStartIdentity: recorded
    })
    if (exited) {
      acquireProfileStateMaintenance(path).release()
      expect(fs.existsSync(owner)).toBe(false)
    } else {
      expect(() => acquireProfileStateMaintenance(path)).toThrow('unverifiable')
      expect(fs.existsSync(owner)).toBe(true)
    }
  })

  it('retries a transient Windows owner publication lock', () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')
    if (!platform) {
      throw new Error('Missing platform descriptor')
    }
    const path = root()
    const rename = fs.renameSync
    const publish = vi
      .spyOn(fs, 'renameSync')
      .mockImplementationOnce(() => {
        throw Object.assign(new Error('scanner holds directory'), { code: 'EPERM' })
      })
      .mockImplementation(rename)
    vi.spyOn(Atomics, 'wait').mockReturnValue('timed-out')
    try {
      Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
      const admission = acquireProfileStateRuntimeAdmission(path)
      expect(publish).toHaveBeenCalledTimes(2)
      admission.release()
      expect(fs.readdirSync(profileStateAccessPaths(path).participants)).toEqual([])
    } finally {
      Object.defineProperty(process, 'platform', platform)
    }
  })

  it('recognizes an exited owner after a hostname change on the same kernel boot', () => {
    const path = root()
    vi.spyOn(identity, 'profileStateAccessBootIdentity').mockReturnValue('same-boot')
    const owner = staleGate(path, 12345, 'previous-hostname', { bootIdentity: 'same-boot' })
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('exited'), { code: 'ESRCH' })
    })
    acquireProfileStateMaintenance(path).release()
    expect(fs.existsSync(owner)).toBe(false)
  })

  it('keeps a differently booted host unverifiable after a hostname change', () => {
    const path = root()
    vi.spyOn(identity, 'profileStateAccessBootIdentity').mockReturnValue('different-boot')
    const owner = staleGate(path, 12345, 'previous-hostname', { bootIdentity: 'owner-boot' })
    const kill = vi.spyOn(process, 'kill')
    expect(() => acquireProfileStateMaintenance(path)).toThrow('verify PID 12345')
    expect(kill).not.toHaveBeenCalled()
    expect(fs.existsSync(owner)).toBe(true)
  })

  it('does not infer exit from a PID in another platform on a shared root', () => {
    const path = root()
    const owner = staleGate(path)
    const record: unknown = JSON.parse(fs.readFileSync(owner, 'utf8'))
    if (typeof record !== 'object' || record === null) {
      throw new Error('Owner fixture missing')
    }
    fs.writeFileSync(
      owner,
      JSON.stringify({ ...record, platform: process.platform === 'win32' ? 'linux' : 'win32' })
    )
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('absent here'), { code: 'ESRCH' })
    })
    expect(() => acquireProfileStateMaintenance(path)).toThrow('unverifiable')
    expect(kill).not.toHaveBeenCalled()
    expect(fs.existsSync(owner)).toBe(true)
  })

  it.skipIf(process.platform !== 'linux')(
    'refuses a different Linux PID namespace even with the same hostname',
    () => {
      const path = root()
      const owner = staleGate(path)
      const record: unknown = JSON.parse(fs.readFileSync(owner, 'utf8'))
      if (typeof record !== 'object' || record === null) {
        throw new Error('Owner fixture missing')
      }
      fs.writeFileSync(owner, JSON.stringify({ ...record, pidNamespace: 'pid:[foreign]' }))
      expect(() => acquireProfileStateMaintenance(path)).toThrow('unverifiable')
      expect(fs.existsSync(owner)).toBe(true)
    }
  )

  it.each(['EPERM', 'EINVAL', 'EACCES'])('refuses unverifiable process query %s', (code) => {
    const path = root()
    const owner = staleGate(path)
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error(code), { code })
    })
    expect(() => acquireProfileStateMaintenance(path)).toThrow('unverifiable')
    expect(fs.existsSync(owner)).toBe(true)
  })

  it('refuses live reused PIDs regardless of old timestamps', () => {
    const path = root()
    const owner = staleGate(path, process.pid)
    fs.utimesSync(owner, 0, 0)
    expect(() => acquireProfileStateMaintenance(path)).toThrow('in use')
    expect(fs.existsSync(owner)).toBe(true)
  })

  it('refuses foreign host and malformed owners without reclaiming them', () => {
    const path = root()
    const owner = staleGate(path, process.pid, `${hostname()}-other`)
    expect(() => acquireProfileStateMaintenance(path)).toThrow('unverifiable')
    fs.writeFileSync(owner, '{}')
    expect(() => acquireProfileStateMaintenance(path)).toThrow('malformed')
    expect(fs.existsSync(owner)).toBe(true)
  })

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
