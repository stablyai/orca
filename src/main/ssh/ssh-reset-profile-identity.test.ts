import {
  mkdtempSync,
  mkdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  realpathSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { captureSshResetProfileIdentity } from './ssh-reset-profile-identity'

let directory: string
let profile: string
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'orca-reset-profile-identity-'))
  profile = join(directory, 'profile')
  mkdirSync(profile)
})
afterEach(() => rmSync(directory, { recursive: true, force: true }))

it('keeps identity through ordinary writes within the same profile', () => {
  const identity = captureSshResetProfileIdentity(profile)
  writeFileSync(join(profile, 'record.json'), '{}')
  mkdirSync(join(profile, 'records'))
  expect(identity.physicalPath).toBe(realpathSync.native(profile))
  expect(identity.assertCurrent).not.toThrow()
})

it('rejects replacement at the same profile pathname', () => {
  const identity = captureSshResetProfileIdentity(profile)
  renameSync(profile, join(directory, 'original-profile'))
  mkdirSync(profile)
  expect(identity.assertCurrent).toThrow('identity_changed')
})

it('resolves aliases to the same physical path and rejects alias retargeting', () => {
  const alias = join(directory, 'alias')
  symlinkSync(profile, alias, process.platform === 'win32' ? 'junction' : 'dir')
  const identity = captureSshResetProfileIdentity(alias)
  expect(identity.physicalPath).toBe(captureSshResetProfileIdentity(profile).physicalPath)
  const replacement = join(directory, 'replacement')
  mkdirSync(replacement)
  renameSync(alias, join(directory, 'original-alias'))
  symlinkSync(replacement, alias, process.platform === 'win32' ? 'junction' : 'dir')
  expect(identity.assertCurrent).toThrow('identity_changed')
})

it('refuses disappearance rather than assuming a profile is empty', () => {
  const identity = captureSshResetProfileIdentity(profile)
  renameSync(profile, join(directory, 'moved-profile'))
  expect(identity.assertCurrent).toThrow('identity_unavailable')
})

it('requires an existing absolute directory', () => {
  const file = join(directory, 'file')
  writeFileSync(file, '')
  for (const path of [file, join(directory, 'missing'), 'relative-profile']) {
    expect(() => captureSshResetProfileIdentity(path)).toThrow('identity_unavailable')
  }
})
