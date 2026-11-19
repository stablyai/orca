import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type * as CredentialIo from '../../credentials/credential-file-io'
import { setSecretStore } from '../../../shared/secure-storage/secret-store'
import {
  clearOrcaCloudSession,
  flushUnsavedOrcaCloudSessionsOnShutdown,
  getOrcaCloudSessionPath,
  saveOrcaCloudSession,
  type OrcaCloudSession
} from './profile-cloud-session-store'
import { signOutCloudSession } from './profile-cloud-session-owner'

const failure = vi.hoisted(() => ({ fail: true }))
vi.mock('../../credentials/credential-file-io', async (original) => {
  const actual = await original<typeof CredentialIo>()
  return {
    ...actual,
    stageCredentialFile: (...args: Parameters<typeof actual.stageCredentialFile>) => {
      if (failure.fail) {
        return Promise.reject(new Error('temporary lock'))
      }
      return actual.stageCredentialFile(...args)
    }
  }
})

let home: string
const rotated: OrcaCloudSession = {
  accessToken: 'access-rotated',
  refreshToken: 'refresh-rotated',
  expiresAt: 9999,
  capabilities: { flags: {}, refreshedAt: 1 }
}
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'orca-session-shutdown-'))
  failure.fail = true
  setSecretStore({
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(value),
    decryptString: (value) => value.toString(),
    describeProtectionGap: () => null
  })
})
afterEach(async () => {
  await clearOrcaCloudSession('profile', home)
  rmSync(home, { recursive: true, force: true })
})

it('persists a recovered rotation before returning from OS shutdown', async () => {
  await saveOrcaCloudSession('profile', home, rotated, { spentOnFailure: true })
  failure.fail = false
  flushUnsavedOrcaCloudSessionsOnShutdown()
  const envelope = JSON.parse(readFileSync(getOrcaCloudSessionPath('profile', home), 'utf8'))
  expect(envelope.format).toBe('electron-safe-storage-v1')
  expect(JSON.parse(Buffer.from(envelope.ciphertext, 'base64').toString()).refreshToken).toBe(
    'refresh-rotated'
  )
})

it('does not restore a rotation over a queued sign-out', async () => {
  await saveOrcaCloudSession('profile', home, rotated, { spentOnFailure: true })
  const signingOut = signOutCloudSession('profile', home)
  flushUnsavedOrcaCloudSessionsOnShutdown()
  expect(existsSync(getOrcaCloudSessionPath('profile', home))).toBe(false)
  await signingOut
})

it('does not overtake a newer file save', async () => {
  await saveOrcaCloudSession('profile', home, rotated, { spentOnFailure: true })
  failure.fail = false
  const saving = saveOrcaCloudSession('profile', home, { ...rotated, refreshToken: 'new-sign-in' })
  flushUnsavedOrcaCloudSessionsOnShutdown()
  expect(existsSync(getOrcaCloudSessionPath('profile', home))).toBe(false)
  await saving
  const envelope = JSON.parse(readFileSync(getOrcaCloudSessionPath('profile', home), 'utf8'))
  expect(JSON.parse(Buffer.from(envelope.ciphertext, 'base64').toString()).refreshToken).toBe(
    'new-sign-in'
  )
})
