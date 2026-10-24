import {
  closeTestStores,
  testState,
  createStore,
  writeDataFile,
  readDataFile
} from './persistence-test-harness'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { rmSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { SshTarget } from '../shared/ssh-types'
import { isRemoteCliControlAllowed } from '../shared/ssh-remote-cli-control'
import { SshConnectionStore } from './ssh/connection/ssh-connection-store'

vi.mock('./ssh/config/ssh-config-parser', () => ({
  loadUserSshConfig: vi.fn(),
  sshConfigHostsToTargets: vi.fn()
}))
vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (plaintext: string) => Buffer.from(`encrypted:${plaintext}`, 'utf-8'),
    decryptString: (ciphertext: Buffer) => ciphertext.toString('utf-8').slice('encrypted:'.length)
  }
}))
vi.mock('./telemetry/client', () => ({ track: vi.fn() }))
vi.mock('./telemetry/cohort-classifier', () => ({
  getCohortAtEmit: () => ({ nth_repo_added: 2 })
}))

const host = (id: string, extra: Partial<SshTarget> = {}): SshTarget => ({
  id,
  label: id,
  host: `${id}.example.com`,
  port: 22,
  username: 'dev',
  ...extra
})

function writeProfile(sshTargets: SshTarget[], settings: Record<string, unknown> = {}): void {
  writeDataFile({
    schemaVersion: 1,
    repos: [],
    worktreeMeta: {},
    settings,
    ui: {},
    githubCache: { pr: {}, issue: {} },
    workspaceSession: {},
    sshTargets
  })
}

async function reopenStore(): Promise<ReturnType<typeof createStore>> {
  await closeTestStores()
  return createStore()
}

// The orcad serve host uses the same SSH-target loading path.
describe("pinning existing hosts' orca CLI control switch on upgrade", () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-test-'))
  })

  afterEach(async () => {
    await closeTestStores()
    rmSync(testState.dir, { recursive: true, force: true })
  })

  it('turns an existing absent switch off and keeps explicit values', async () => {
    writeProfile([
      host('absent'),
      host('on', { allowRemoteCliControl: true }),
      host('off', { allowRemoteCliControl: false })
    ])

    const store = await createStore()

    expect(store.getSshTarget('absent')?.allowRemoteCliControl).toBe(false)
    expect(isRemoteCliControlAllowed(store.getSshTarget('absent'))).toBe(false)
    expect(store.getSshTarget('on')?.allowRemoteCliControl).toBe(true)
    expect(store.getSshTarget('off')?.allowRemoteCliControl).toBe(false)
    expect(store.getSettings().sshRemoteCliControlExistingHostsMigrated).toBe(true)

    store.flush()
    expect(readDataFile()).toMatchObject({
      sshTargets: expect.arrayContaining([
        expect.objectContaining({ id: 'absent', allowRemoteCliControl: false })
      ]),
      settings: expect.objectContaining({ sshRemoteCliControlExistingHostsMigrated: true })
    })
  })

  it('runs once, so hosts added afterwards keep the on-by-default switch', async () => {
    writeProfile([host('existing')])
    const store = await createStore()
    const added = new SshConnectionStore(store).addTarget({
      label: 'new',
      host: 'new.example.com',
      port: 22,
      username: 'dev',
      allowRemoteCliControl: true
    })
    store.flush()

    const reopened = await reopenStore()

    expect(reopened.getSshTarget('existing')?.allowRemoteCliControl).toBe(false)
    expect(reopened.getSshTarget(added.id)?.allowRemoteCliControl).toBe(true)
    expect(isRemoteCliControlAllowed(reopened.getSshTarget(added.id))).toBe(true)
  })

  it('does not re-run after a downgrade wrote an absent switch alongside the marker', async () => {
    // Older builds preserve unknown migration markers when saving settings.
    writeProfile([host('added-by-older-build')], {
      sshRemoteCliControlExistingHostsMigrated: true
    })

    const store = await createStore()

    expect(store.getSshTarget('added-by-older-build')).not.toHaveProperty('allowRemoteCliControl')
  })
})
