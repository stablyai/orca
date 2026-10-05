import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { closeTestStores, createStore, testState } from './persistence-test-harness'

vi.mock('electron', () => ({
  app: {
    getPath: () => testState.dir
  },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (plaintext: string) => Buffer.from(`encrypted:${plaintext}`, 'utf-8'),
    decryptString: (ciphertext: Buffer) => ciphertext.toString('utf-8').replace(/^encrypted:/, '')
  }
}))

vi.mock('./ssh/ssh-config-parser', () => ({
  loadUserSshConfig: vi.fn(() => ({ hosts: [] })),
  sshConfigHostsToTargets: vi.fn(() => [])
}))

describe('Store project group folder', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-test-'))
  })

  afterEach(async () => {
    await closeTestStores()
    rmSync(testState.dir, { recursive: true, force: true })
  })

  it('sets a project group folder so a group-scoped workspace has somewhere to open', async () => {
    const store = await createStore()
    const group = store.createProjectGroup({ name: 'Platform', createdFrom: 'manual' })

    expect(group.parentPath).toBeNull()
    expect(
      store.updateProjectGroup(group.id, { parentPath: '/Users/me/platform' })?.parentPath
    ).toBe('/Users/me/platform')
  })

  it('trims a project group folder and clears it when the value is blank', async () => {
    const store = await createStore()
    const group = store.createProjectGroup({ name: 'Platform', createdFrom: 'manual' })

    expect(
      store.updateProjectGroup(group.id, { parentPath: '  /Users/me/platform  ' })?.parentPath
    ).toBe('/Users/me/platform')
    // Why: blank must clear rather than point a workspace at the filesystem root.
    expect(store.updateProjectGroup(group.id, { parentPath: '   ' })?.parentPath).toBeNull()
  })

  it('leaves the project group folder untouched when the update omits it', async () => {
    const store = await createStore()
    const group = store.createProjectGroup({ name: 'Platform', createdFrom: 'manual' })
    store.updateProjectGroup(group.id, { parentPath: '/Users/me/platform' })

    expect(store.updateProjectGroup(group.id, { name: 'Renamed' })?.parentPath).toBe(
      '/Users/me/platform'
    )
  })
})

describe('Store project group colour and icon', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-test-'))
  })

  afterEach(async () => {
    await closeTestStores()
    rmSync(testState.dir, { recursive: true, force: true })
  })

  it('normalizes a project group colour to hex and drops garbage', async () => {
    const store = await createStore()
    const group = store.createProjectGroup({ name: 'Platform', createdFrom: 'manual' })

    expect(store.updateProjectGroup(group.id, { color: '#ABC' })?.color).toBe('#aabbcc')
    // Why: the field previously stored any string, so anything could reach a style attribute.
    expect(
      store.updateProjectGroup(group.id, { color: 'red; background: url()' })?.color
    ).toBeNull()
  })

  it('sanitizes a project group icon and rejects an unsupported shape', async () => {
    const store = await createStore()
    const group = store.createProjectGroup({ name: 'Platform', createdFrom: 'manual' })

    expect(
      store.updateProjectGroup(group.id, { icon: { type: 'emoji', emoji: '🎧' } })?.icon
    ).toEqual({ type: 'emoji', emoji: '🎧' })
    expect(
      store.updateProjectGroup(group.id, { icon: { type: 'nonsense' } } as never)?.icon
    ).toBeNull()
  })
})
