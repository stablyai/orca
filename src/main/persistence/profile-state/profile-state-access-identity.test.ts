import * as fs from 'node:fs'
import { afterEach, expect, it, vi } from 'vitest'

vi.mock('node:fs', async (importOriginal) => ({ ...(await importOriginal<typeof fs>()) }))

const platform = Object.getOwnPropertyDescriptor(process, 'platform')

afterEach(() => {
  vi.restoreAllMocks()
  if (platform) {
    Object.defineProperty(process, 'platform', platform)
  }
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
