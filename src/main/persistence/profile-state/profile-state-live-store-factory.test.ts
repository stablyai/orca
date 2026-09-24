import { build } from 'esbuild'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { agentHookServer } from '../../agent-hooks/server'
import { buildProfileStateCutoverFixture } from '../profile-state-cutover-fixture'
import type { Store } from '../loading-store/store'
import { ProfileStateSqliteAuthority } from './profile-state-sqlite-authority'
import { createLiveProfileStateStore } from './profile-state-live-store-factory'
import { profileStateJsonExportPath } from './profile-state-export-path'
import { profileStateDatabaseBackups } from './profile-state-backup-path'

vi.mock('../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: () => ({ nth_repo_added: 2 })
}))
vi.mock('../../ssh/ssh-config-parser', () => ({
  loadUserSshConfig: () => ({ hosts: [] }),
  sshConfigHostsToTargets: () => []
}))

let bundleRoot: string
let workerOptions: { workerPath: string; backupWorkerPath: string }
const roots: string[] = []
const stores: Store[] = []

beforeAll(async () => {
  bundleRoot = mkdtempSync(join(tmpdir(), 'orca-live-writer-bundle-'))
  workerOptions = {
    workerPath: join(bundleRoot, 'profile-state-writer-worker-entry.js'),
    backupWorkerPath: join(bundleRoot, 'profile-state-backup-worker-entry.js')
  }
  await build({
    entryPoints: [
      resolve('src/main/persistence/profile-state/profile-state-writer-worker-entry.ts'),
      resolve('src/main/persistence/profile-state/profile-state-backup-worker-entry.ts')
    ],
    outdir: bundleRoot,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    logLevel: 'silent'
  })
})

afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.freezeWritesAsync()))
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
  vi.restoreAllMocks()
})
afterAll(() => rmSync(bundleRoot, { recursive: true, force: true }))

function options() {
  const root = mkdtempSync(join(tmpdir(), 'orca-live-profile-'))
  roots.push(root)
  return {
    dataFile: join(root, 'orca-data.json'),
    databaseFile: join(root, 'profile-state.db'),
    profileId: 'live-profile-test',
    authorityMode: 'sqlite-candidate' as const
  }
}

async function open(input: ReturnType<typeof options>) {
  const result = await createLiveProfileStateStore(input, workerOptions)
  stores.push(result.store)
  return result
}

function readState(input: ReturnType<typeof options>) {
  const reader = new ProfileStateSqliteAuthority(input.databaseFile, input.profileId)
  try {
    return JSON.parse(reader.readSerializedState() ?? '{}')
  } finally {
    reader.close()
  }
}

describe('live profile authority admission', () => {
  it.each([false, true])(
    'hands unbound aliases to admitted startup only (worker refused=%s)',
    async (refused) => {
      const input = options()
      const source = buildProfileStateCutoverFixture(join(input.dataFile, '..'))
      const session = source.workspaceSession
      for (const tab of Object.values(session.tabsByWorktree).flat()) {
        tab.ptyId = null
      }
      session.terminalLayoutsByTabId['tab-local'] = {
        root: { type: 'leaf', leafId: 'pane:1' },
        activeLeafId: 'pane:1',
        expandedLeafId: null,
        ptyIdsByLeafId: {}
      }
      writeFileSync(input.dataFile, JSON.stringify(source))
      const register = vi.spyOn(agentHookServer, 'registerPaneKeyAlias')
      if (refused) {
        await expect(
          createLiveProfileStateStore(input, {
            workerPath: join(input.dataFile, '..', 'missing-worker.js')
          })
        ).rejects.toThrow()
        expect(register).not.toHaveBeenCalled()
        return
      }
      const { store } = await open(input)
      const leafId = store.getWorkspaceSession().terminalLayoutsByTabId['tab-local'].activeLeafId
      const userDataPath = join(input.dataFile, '..')
      mkdirSync(join(userDataPath, 'agent-hooks'), { recursive: true })
      writeFileSync(
        join(userDataPath, 'agent-hooks', 'last-status.json'),
        JSON.stringify({
          version: 2,
          entries: {
            'tab-local:1': {
              paneKey: 'tab-local:1',
              tabId: 'tab-local',
              worktreeId: 'repo-local::/fixture/local',
              connectionId: null,
              receivedAt: Date.now(),
              stateStartedAt: Date.now(),
              payload: { state: 'working', prompt: 'legacy cached', agentType: 'claude' }
            }
          }
        })
      )
      try {
        await agentHookServer.start({ env: 'production', userDataPath })
        expect(agentHookServer.getStatusSnapshot()).toContainEqual(
          expect.objectContaining({
            paneKey: `tab-local:${leafId}`,
            prompt: 'legacy cached'
          })
        )
      } finally {
        agentHookServer.stop()
      }
    }
  )

  it('migrates once, loads admitted state and reopens worker-acknowledged writes', async () => {
    const input = options()
    writeFileSync(
      input.dataFile,
      JSON.stringify(buildProfileStateCutoverFixture(join(input.dataFile, '..')))
    )
    const { store, migrated, backend } = await open(input)
    expect({ migrated, backend }).toEqual({ migrated: true, backend: 'sqlite' })
    store.updateSettings({ theme: 'dark' })
    await store.flushPendingOrThrowAsync()
    await store.freezeWritesAsync()
    const reopened = await open(input)
    expect(reopened.migrated).toBe(false)
    expect(reopened.store.getSettings().theme).toBe('dark')
    expect(readState(input).automationRuns).toHaveLength(1)
  })

  it('never adopts a competing revision between bootstrap and worker readiness', async () => {
    const input = options()
    const original = ProfileStateSqliteAuthority.prototype.retireForWorker
    vi.spyOn(ProfileStateSqliteAuthority.prototype, 'retireForWorker').mockImplementation(
      function (this: ProfileStateSqliteAuthority) {
        const handoff = original.call(this)
        const peer = new ProfileStateSqliteAuthority(input.databaseFile, input.profileId)
        try {
          peer.readSerializedState()
          peer.writeSerializedDomains([{ domain: 'peer', payload: '{"retained":true}' }])
        } finally {
          peer.close()
        }
        return handoff
      }
    )
    await expect(open(input)).rejects.toThrow('Profile state revision changed')
    expect(readState(input).peer).toEqual({ retained: true })
  })

  it('refuses startup when the worker is unavailable without selecting JSON', async () => {
    const input = options()
    await expect(
      createLiveProfileStateStore(input, { workerPath: join(bundleRoot, 'missing.js') })
    ).rejects.toThrow('Profile state writer')
    expect(() => readFileSync(input.dataFile)).toThrow()
    const reopened = await open(input)
    expect(reopened.backend).toBe('sqlite')
  })

  it('orders exports with full checkpoints and closes backup and writer handles on final flush', async () => {
    const input = options()
    const { store } = await open(input)
    store.getWorkspaceSession().activeTabId = 'getter-export'
    store.updateSettings({ theme: 'dark' })
    const revision = await store.writeLatestProfileStateJsonExportAsync()
    expect(revision).toBeTypeOf('number')
    if (revision === undefined) {
      throw new Error('Expected a persisted profile revision')
    }
    expect(
      JSON.parse(readFileSync(profileStateJsonExportPath(input.dataFile, revision), 'utf8'))
        .workspaceSession.activeTabId
    ).toBe('getter-export')
    store.updateSettings({ theme: 'light' })
    await store.flushFinalOrThrowAsync({ exportJsonCompatibility: true })
    expect(JSON.parse(readFileSync(input.dataFile, 'utf8')).settings.theme).toBe('light')
    expect(profileStateDatabaseBackups(input.databaseFile).length).toBeGreaterThan(0)
    expect(readState(input).settings.theme).toBe('light')
    await expect(store.flushPendingOrThrowAsync()).rejects.toThrow('finalized')
    const reopened = await open(input)
    expect(reopened.store.getSettings().theme).toBe('light')
  })
})
