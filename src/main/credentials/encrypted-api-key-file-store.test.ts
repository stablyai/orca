import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import type * as Os from 'node:os'
import type * as CredentialFileIo from './credential-file-io'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { setSecretStore } from '../../shared/secure-storage/secret-store'
import { createEncryptedApiKeyFileStore } from './encrypted-api-key-file-store'

const state = vi.hoisted(() => ({
  home: '',
  entered: () => {},
  resume: Promise.resolve(),
  pause: true
}))

vi.mock('node:os', async (original) => ({
  ...(await original<typeof Os>()),
  homedir: () => state.home
}))
vi.mock('./credential-file-io', async (original) => ({
  ...(await original<typeof CredentialFileIo>()),
  stageCredentialFile: async (path: string, data: string) => {
    if (state.pause) {
      state.pause = false
      state.entered()
      await state.resume
    }
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, data)
    return true
  }
}))

beforeEach(() => {
  state.home = mkdtempSync(join(tmpdir(), 'orca-key-order-'))
  state.pause = true
  setSecretStore({
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(value),
    decryptString: (value) => value.toString(),
    describeProtectionGap: () => null
  })
})
afterEach(() => rmSync(state.home, { recursive: true, force: true }))

it.each(['save', 'clear'] as const)('orders a pending save before a later %s', async (action) => {
  const store = createEncryptedApiKeyFileStore({
    fileName: 'key.enc',
    envelopePrefix: 'fixture:v1:',
    providerLabel: 'Fixture',
    logScope: 'fixture'
  })
  let entered!: () => void
  let resume!: () => void
  const started = new Promise<void>((resolve) => {
    entered = resolve
  })
  state.entered = entered
  state.resume = new Promise<void>((resolve) => {
    resume = resolve
  })
  const first = store.save('first')
  await started
  const next = action === 'save' ? store.save('second') : store.clear()
  await Promise.resolve()
  resume()
  await Promise.all([first, next])

  if (action === 'save') {
    expect(await store.read()).toBe('second')
    expect(readFileSync(join(state.home, '.orca', 'key.enc'), 'utf8')).toBe(
      'fixture:v1:encrypted:c2Vjb25k'
    )
  } else {
    expect(await store.has()).toBe(false)
    expect(await store.read()).toBeNull()
  }
})
