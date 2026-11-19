import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type * as CredentialIo from '../../credentials/credential-file-io'
import { setSecretStore } from '../../../shared/secure-storage/secret-store'
import {
  flushUnsavedCloudSessions,
  readCloudSession,
  signInCloudSession,
  signOutCloudSession
} from './profile-cloud-session-owner'
import type { OrcaCloudSessionExchangeResponse } from './profile-cloud-session-exchange'

const gate = vi.hoisted(() => ({ entered: () => {}, resume: Promise.resolve(), pause: true }))
vi.mock('../../credentials/credential-file-io', async (original) => {
  const actual = await original<typeof CredentialIo>()
  return {
    ...actual,
    stageCredentialFile: async (...args: Parameters<typeof actual.stageCredentialFile>) => {
      if (gate.pause) {
        gate.pause = false
        gate.entered()
        await gate.resume
      }
      return actual.stageCredentialFile(...args)
    }
  }
})
let home = ''
afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

it.each(['save', 'clear'])(
  'orders a pending session save before a later %s and drains it at quit',
  async (action) => {
    home = await mkdtemp(join(tmpdir(), 'orca-session-order-'))
    setSecretStore({
      isEncryptionAvailable: () => true,
      encryptString: (value) => Buffer.from(value),
      decryptString: (value) => value.toString(),
      describeProtectionGap: () => null
    })
    const entered = Promise.withResolvers<void>()
    const resume = Promise.withResolvers<void>()
    gate.entered = entered.resolve
    gate.resume = resume.promise
    gate.pause = true
    const exchange: OrcaCloudSessionExchangeResponse = {
      accessToken: 'access-first',
      refreshToken: 'refresh-first',
      expiresAt: 9999,
      capabilities: { flags: {}, refreshedAt: 1 },
      cloud: { cloudProfileId: 'cloud-1', userId: 'user-1', email: 'a@example.com', linkedAt: 1 }
    }
    const saving = signInCloudSession('profile-1', home, exchange)
    const saved =
      action === 'clear' ? expect(saving).rejects.toThrow('orca_cloud_auth_cancelled') : saving
    await entered.promise
    const next =
      action === 'clear'
        ? signOutCloudSession('profile-1', home)
        : signInCloudSession('profile-1', home, { ...exchange, refreshToken: 'refresh-second' })
    const flushing = flushUnsavedCloudSessions()
    resume.resolve()
    await Promise.all([saved, next, flushing])
    if (action === 'clear') {
      expect(await readCloudSession('profile-1', home)).toEqual({
        status: 'missing',
        persistence: 'none'
      })
    } else {
      expect(await readCloudSession('profile-1', home)).toMatchObject({
        status: 'found',
        session: { refreshToken: 'refresh-second' }
      })
    }
    await signInCloudSession('profile-1', home, { ...exchange, refreshToken: 'refresh-next' })
    expect(await readCloudSession('profile-1', home)).toMatchObject({
      status: 'found',
      session: { refreshToken: 'refresh-next' }
    })
  }
)
