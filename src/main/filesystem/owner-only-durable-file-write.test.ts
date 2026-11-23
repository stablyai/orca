import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'

const { security, userSid } = await vi.hoisted(async () => {
  const { createFakeWindowsSecurity, FAKE_USER_SID } =
    await import('../../shared/secure-storage/windows-security-addon.test-fixture')
  return { security: createFakeWindowsSecurity(), userSid: FAKE_USER_SID }
})

vi.mock('../../shared/secure-storage/windows-security-addon', async (original) => ({
  ...(await original()),
  loadWindowsSecurity: () => {
    throw new Error('The async writer must not load Windows security synchronously')
  },
  loadWindowsSecurityAsync: async () => ({ addon: security, userSid })
}))

import { writeOwnerOnlyFileDurable } from './owner-only-durable-file-write'
import { findSecureDaclViolation } from '../../shared/secure-storage/windows-secure-dacl'

const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
const directories: string[] = []
afterEach(async () => {
  Object.defineProperty(process, 'platform', platform)
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })))
})

it('publishes durable owner-only contents using asynchronous Windows security initialization', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'orca-owner-only-write-'))
  directories.push(directory)
  Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
  const target = join(directory, 'member.json')
  await writeOwnerOnlyFileDurable(target, '{"member":"alice"}')
  expect(await readFile(target, 'utf8')).toBe('{"member":"alice"}')
  const restriction = security.callsFor('setAsync').find((call) => call.path.endsWith('.tmp'))
  if (!restriction) {
    throw new Error('The staged member file was not restricted before publication')
  }
  expect(findSecureDaclViolation(security.getDaclAces(restriction.path), userSid, false)).toBeNull()
})
