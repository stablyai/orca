import * as fs from 'node:fs'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const native = vi.hoisted(() => ({
  registry: vi.fn(),
  creationTime: vi.fn()
}))
vi.mock('../../windows-native-registry', () => ({
  WINDOWS_REG_SZ: 1,
  loadWindowsNativeRegistry: () => ({ HK: { LM: 123 }, getRegistryKey: native.registry })
}))
vi.mock('../../windows/windows-process-table', () => ({
  readWindowsProcessCreationTime: native.creationTime
}))

vi.mock('node:fs', async (importOriginal) => ({ ...(await importOriginal<typeof fs>()) }))

const platform = Object.getOwnPropertyDescriptor(process, 'platform')

beforeEach(() => {
  vi.resetModules()
  native.registry.mockReset()
  native.creationTime.mockReset().mockReturnValue(null)
})

afterEach(() => {
  vi.restoreAllMocks()
  if (platform) {
    Object.defineProperty(process, 'platform', platform)
  }
})

it.each([
  [
    'AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE',
    'win32-machine-guid:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
  ],
  ['00000000-0000-0000-0000-000000000000', null],
  ['invalid-machine-id', null],
  ['', null]
] as const)('validates the Windows machine GUID %j', async (value, expected) => {
  Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
  native.registry.mockReturnValue({ MACHINEGUID: { type: 1, value } })
  const { profileStateAccessMachineIdentity } = await import('./profile-state-access-identity')
  expect(profileStateAccessMachineIdentity()).toBe(expected)
  expect(profileStateAccessMachineIdentity()).toBe(expected)
  expect(native.registry).toHaveBeenCalledExactlyOnceWith(123, 'SOFTWARE\\Microsoft\\Cryptography')
})

it.each([
  null,
  {},
  { MachineGuid: { type: 4, value: 123 } },
  { MachineGuid: { type: 1, value: [] } }
])('keeps unavailable Windows machine identity unverifiable', async (values) => {
  Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
  native.registry.mockReturnValue(values)
  const { profileStateAccessMachineIdentity } = await import('./profile-state-access-identity')
  expect(profileStateAccessMachineIdentity()).toBeNull()
})

it('tolerates a denied registry query', async () => {
  Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
  native.registry.mockImplementation(() => {
    throw new Error('access denied')
  })
  const { profileStateAccessMachineIdentity } = await import('./profile-state-access-identity')
  expect(profileStateAccessMachineIdentity()).toBeNull()
})

it('caches only its own Windows creation time and leaves boot identity unavailable', async () => {
  Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
  native.creationTime.mockReturnValue(1_700_000_000_000)
  const { profileStateAccessProcessIdentity, profileStateAccessBootIdentity } =
    await import('./profile-state-access-identity')
  expect(profileStateAccessBootIdentity()).toBeNull()
  expect(profileStateAccessProcessIdentity(process.pid)).toBe('win32-creation-ms:1700000000000')
  native.creationTime.mockReturnValue(1_800_000_000_000)
  expect(profileStateAccessProcessIdentity(process.pid)).toBe('win32-creation-ms:1700000000000')
  expect(profileStateAccessProcessIdentity(process.pid + 1)).toBe('win32-creation-ms:1800000000000')
  native.creationTime.mockReturnValue(null)
  expect(profileStateAccessProcessIdentity(process.pid + 1)).toBeNull()
  expect(native.creationTime).toHaveBeenCalledTimes(3)
})

it.each([
  ['8de277067b3544d4b65c267d0edab928\n', '8de277067b3544d4b65c267d0edab928'],
  ['00000000000000000000000000000000', null],
  ['uninitialized\n', null],
  ['invalid-machine-id', null],
  ['', null]
] as const)('validates the Linux machine identity %j', async (contents, expected) => {
  vi.resetModules()
  Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' })
  const read = fs.readFileSync
  vi.spyOn(fs, 'readFileSync').mockImplementation((path, options) =>
    path === '/etc/machine-id' ? contents : read(path, options)
  )
  const { profileStateAccessMachineIdentity } = await import('./profile-state-access-identity')
  expect(profileStateAccessMachineIdentity()).toBe(expected)
})
