import { randomUUID } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  acquireProfileStateMaintenance,
  acquireProfileStateRuntimeAdmission
} from './profile-state-access'
import { profileStateAccessPaths } from './profile-state-access-owner'

const identity = vi.hoisted(() => ({
  boot: vi.fn(),
  machine: vi.fn(),
  process: vi.fn()
}))
vi.mock('./profile-state-access-identity', () => ({
  profileStateAccessBootIdentity: identity.boot,
  profileStateAccessMachineIdentity: identity.machine,
  profileStateAccessProcessIdentity: identity.process
}))

const platform = Object.getOwnPropertyDescriptor(process, 'platform')
let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-state-access-windows-'))
  Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
  identity.boot.mockReset().mockReturnValue(null)
  identity.machine.mockReset().mockReturnValue('win32-machine-guid:this-machine')
  identity.process.mockReset().mockReturnValue('win32-creation-ms:2000')
  vi.spyOn(process, 'kill').mockReturnValue(true)
})

afterEach(() => {
  vi.restoreAllMocks()
  if (platform) {
    Object.defineProperty(process, 'platform', platform)
  }
  rmSync(root, { recursive: true, force: true })
})

function writeOwner(overrides: Record<string, unknown> = {}, exclusive = true): string {
  const paths = profileStateAccessPaths(root)
  const token = randomUUID()
  const directory = exclusive ? paths.maintenance : join(paths.participants, token)
  mkdirSync(directory)
  const path = join(directory, `${token}.owner`)
  writeFileSync(
    path,
    JSON.stringify({
      token,
      pid: 12345,
      host: hostname(),
      platform: 'win32',
      pidNamespace: null,
      bootIdentity: null,
      machineIdentity: 'win32-machine-guid:this-machine',
      processStartIdentity: 'win32-creation-ms:1000',
      ...overrides
    })
  )
  return path
}

it('records the machine and native creation time before publishing a runtime admission', () => {
  const admission = acquireProfileStateRuntimeAdmission(root)
  const participants = profileStateAccessPaths(root).participants
  const token = readdirSync(participants)[0]
  expect(
    JSON.parse(readFileSync(join(participants, token, `${token}.owner`), 'utf8'))
  ).toMatchObject({
    pid: process.pid,
    platform: 'win32',
    machineIdentity: 'win32-machine-guid:this-machine',
    processStartIdentity: 'win32-creation-ms:2000',
    bootIdentity: null
  })
  admission.release()
})

it.each([true, false])(
  'reclaims a reused PID on the same machine without a boot UUID: maintenance=%s',
  (exclusive) => {
    const path = writeOwner({}, exclusive)
    acquireProfileStateMaintenance(root).release()
    expect(existsSync(path)).toBe(false)
    expect(identity.process).toHaveBeenCalledWith(12345)
  }
)

it('lets runtime startup recover a stale maintenance owner', () => {
  const path = writeOwner()
  acquireProfileStateRuntimeAdmission(root).release()
  expect(existsSync(path)).toBe(false)
})

it('uses exact creation times even for reuse within the POSIX timestamp tolerance', () => {
  const path = writeOwner({ processStartIdentity: 'win32-creation-ms:1999' })
  acquireProfileStateMaintenance(root).release()
  expect(existsSync(path)).toBe(false)
})

it('keeps an unchanged process alive across wall-clock changes', () => {
  const path = writeOwner({ processStartIdentity: 'win32-creation-ms:2000' })
  vi.spyOn(Date, 'now').mockReturnValue(9_000_000)
  expect(() => acquireProfileStateMaintenance(root)).toThrow('unverifiable')
  expect(existsSync(path)).toBe(true)
})

it('can reclaim after reboot using the stored absolute creation time', () => {
  const path = writeOwner({ processStartIdentity: 'win32-creation-ms:1700000000000' })
  identity.process.mockReturnValue('win32-creation-ms:1800000000000')
  acquireProfileStateMaintenance(root).release()
  expect(existsSync(path)).toBe(false)
})

it.each([
  { host: 'previous-hostname' },
  { machineIdentity: 'win32-machine-guid:another-machine' },
  { platform: 'linux' }
])(
  'keeps another or unverifiable execution host even when the PID is absent locally: %j',
  (record) => {
    const path = writeOwner(record)
    vi.mocked(process.kill).mockImplementation(() => {
      throw Object.assign(new Error('absent'), { code: 'ESRCH' })
    })
    expect(() => acquireProfileStateMaintenance(root)).toThrow('unverifiable')
    expect(process.kill).not.toHaveBeenCalled()
    expect(existsSync(path)).toBe(true)
  }
)

it('cannot identify another host from a cloned machine GUID and a renamed hostname', () => {
  const path = writeOwner({ host: 'other-host-with-cloned-guid' })
  expect(() => acquireProfileStateMaintenance(root)).toThrow('unverifiable')
  expect(process.kill).not.toHaveBeenCalled()
  expect(existsSync(path)).toBe(true)
})

it('does not infer PID reuse from an unavailable local machine identity', () => {
  const path = writeOwner()
  identity.machine.mockReturnValue(null)
  expect(() => acquireProfileStateMaintenance(root)).toThrow('unverifiable')
  expect(process.kill).toHaveBeenCalledWith(12345, 0)
  expect(identity.process).not.toHaveBeenCalledWith(12345)
  expect(existsSync(path)).toBe(true)
})

it.each([null, undefined])(
  'reclaims a legacy same-host owner with an absent PID and machine identity %s',
  (machineIdentity) => {
    const path = writeOwner({ machineIdentity })
    vi.mocked(process.kill).mockImplementation(() => {
      throw Object.assign(new Error('absent'), { code: 'ESRCH' })
    })
    acquireProfileStateMaintenance(root).release()
    expect(existsSync(path)).toBe(false)
  }
)

it('reclaims an absent same-host PID when the reader cannot load machine identity', () => {
  const path = writeOwner()
  identity.machine.mockReturnValue(null)
  vi.mocked(process.kill).mockImplementation(() => {
    throw Object.assign(new Error('absent'), { code: 'ESRCH' })
  })
  acquireProfileStateMaintenance(root).release()
  expect(existsSync(path)).toBe(false)
})

it.each([null, undefined])(
  'does not compare creation times for a legacy live PID without machine identity %s',
  (machineIdentity) => {
    const path = writeOwner({ machineIdentity })
    expect(() => acquireProfileStateMaintenance(root)).toThrow('unverifiable')
    expect(identity.process).not.toHaveBeenCalledWith(12345)
    expect(existsSync(path)).toBe(true)
  }
)

it.each([
  undefined,
  null,
  'wall-time-ms:1000',
  'win32-creation-ms:0',
  'win32-creation-ms:02000',
  'win32-creation-ms:invalid',
  'win32-creation-ms:99999999999999999'
])('keeps legacy, incompatible or malformed creation identities: %s', (processStartIdentity) => {
  const path = writeOwner({ processStartIdentity })
  expect(() => acquireProfileStateMaintenance(root)).toThrow('unverifiable')
  expect(existsSync(path)).toBe(true)
})

it('does not infer PID reuse when the native identity getter is unavailable', () => {
  const path = writeOwner()
  identity.process.mockReturnValue(null)
  expect(() => acquireProfileStateMaintenance(root)).toThrow('unverifiable')
  expect(existsSync(path)).toBe(true)
})

it.each(['EPERM', 'EACCES', 'EINVAL'])('retains owners on signal query failure %s', (code) => {
  const path = writeOwner()
  vi.mocked(process.kill).mockImplementation(() => {
    throw Object.assign(new Error(code), { code })
  })
  expect(() => acquireProfileStateMaintenance(root)).toThrow('unverifiable')
  expect(existsSync(path)).toBe(true)
})

it('reclaims a positively absent PID from the same machine even without a start timestamp', () => {
  const path = writeOwner({ processStartIdentity: null })
  vi.mocked(process.kill).mockImplementation(() => {
    throw Object.assign(new Error('absent'), { code: 'ESRCH' })
  })
  acquireProfileStateMaintenance(root).release()
  expect(existsSync(path)).toBe(false)
})
