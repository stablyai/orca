import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type * as CredentialIo from '../../credentials/credential-file-io'
import { inCredentialFileOrder } from '../../credentials/credential-file-io'
import { setSecretStore } from '../../../shared/secure-storage/secret-store'
import {
  clearOrcaCloudSession,
  flushUnsavedOrcaCloudSessionsOnShutdown,
  getOrcaCloudSessionPath,
  readOrcaCloudSession,
  saveOrcaCloudSession,
  type OrcaCloudSession
} from './profile-cloud-session-store'
import { signOutCloudSession } from './profile-cloud-session-owner'
import { inCloudSessionOrder } from './profile-cloud-session-order'

const failure = vi.hoisted(
  (): { fail: boolean; hold: { entered: () => void; release: Promise<void> } | null } => ({
    fail: true,
    hold: null
  })
)
vi.mock('../../credentials/credential-file-io', async (original) => {
  const actual = await original<typeof CredentialIo>()
  return {
    ...actual,
    stageCredentialFile: (...args: Parameters<typeof actual.stageCredentialFile>) => {
      if (failure.fail) {
        return Promise.reject(new Error('temporary lock'))
      }
      const hold = failure.hold
      failure.hold = null
      if (!hold) {
        return actual.stageCredentialFile(...args)
      }
      const [path, data, options] = args
      return actual.stageCredentialFile(path, data, {
        ...options,
        shouldPublish: async () => {
          hold.entered()
          await hold.release
          return options?.shouldPublish?.() ?? true
        }
      })
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
  failure.hold = null
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

function savedRefreshToken(): string {
  const envelope = JSON.parse(readFileSync(getOrcaCloudSessionPath('profile', home), 'utf8'))
  return JSON.parse(Buffer.from(envelope.ciphertext, 'base64').toString()).refreshToken
}

it('recovers while a metadata or network operation owns the profile', async () => {
  await saveOrcaCloudSession('profile', home, rotated, { spentOnFailure: true })
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const busy = inCloudSessionOrder('profile', home, async () => {
    entered.resolve()
    await release.promise
  })
  await entered.promise
  failure.fail = false
  flushUnsavedOrcaCloudSessionsOnShutdown()
  expect(savedRefreshToken()).toBe('refresh-rotated')
  release.resolve()
  await busy
})

it.each(['retry', 'queued rotations'] as const)(
  'seals a staged %s before recovering the newest rotation',
  async (kind) => {
    await saveOrcaCloudSession('profile', home, rotated, { spentOnFailure: true })
    failure.fail = false
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    failure.hold = { entered: () => entered.resolve(), release: release.promise }
    const first =
      kind === 'retry'
        ? readOrcaCloudSession('profile', home)
        : saveOrcaCloudSession(
            'profile',
            home,
            { ...rotated, refreshToken: 'older-rotation' },
            { spentOnFailure: true }
          )
    await entered.promise
    const second =
      kind === 'retry'
        ? Promise.resolve()
        : saveOrcaCloudSession(
            'profile',
            home,
            { ...rotated, refreshToken: 'newest-rotation' },
            { spentOnFailure: true }
          )
    flushUnsavedOrcaCloudSessionsOnShutdown()
    expect(savedRefreshToken()).toBe(kind === 'retry' ? 'refresh-rotated' : 'newest-rotation')
    if (process.platform !== 'win32') {
      expect(statSync(getOrcaCloudSessionPath('profile', home)).mode & 0o777).toBe(0o600)
    }
    release.resolve()
    await Promise.all([first, second])
    expect(savedRefreshToken()).toBe(kind === 'retry' ? 'refresh-rotated' : 'newest-rotation')
  }
)

it('does not let an older queued clear delete a rotation recovered at shutdown', async () => {
  await saveOrcaCloudSession('profile', home, rotated, { spentOnFailure: true })
  failure.fail = false
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const blocked = inCredentialFileOrder(getOrcaCloudSessionPath('profile', home), async () => {
    entered.resolve()
    await release.promise
  })
  await entered.promise
  const clearing = clearOrcaCloudSession('profile', home)
  const saving = saveOrcaCloudSession(
    'profile',
    home,
    { ...rotated, refreshToken: 'newest-rotation' },
    { spentOnFailure: true }
  )
  flushUnsavedOrcaCloudSessionsOnShutdown()
  expect(savedRefreshToken()).toBe('newest-rotation')
  release.resolve()
  await Promise.all([blocked, clearing, saving])
  expect(savedRefreshToken()).toBe('newest-rotation')
})
