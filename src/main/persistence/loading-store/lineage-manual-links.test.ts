import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  closeTestStores,
  createStore,
  testState,
  writeDataFile
} from '../../persistence-test-harness'
import { DEFAULT_LINEAGE_DISCOVERY } from '../../../shared/lineage-discovery-types'
import { normalizeManualLinks } from './normalize-loaded-profile-state'

vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (plaintext: string) => Buffer.from(`encrypted:${plaintext}`, 'utf-8'),
    decryptString: (ciphertext: Buffer) => ciphertext.toString('utf-8').slice('encrypted:'.length)
  }
}))

const PARENT = 'worktree:r1::/w/a'

describe('lineage manual links and discovery settings persistence', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-test-'))
  })

  afterEach(async () => {
    await closeTestStores()
    rmSync(testState.dir, { recursive: true, force: true })
  })

  it('round-trips manual links per parent workspace key', async () => {
    const store = await createStore()
    const link = { id: 'l1', repoName: 'loan-core', number: 12, addedAt: 1 }
    store.setLineageManualLinks(PARENT, [link])
    store.flush()

    const reloaded = await createStore()
    expect(reloaded.getLineageManualLinks(PARENT)).toEqual([link])
    expect(reloaded.getLineageManualLinks('worktree:r1::/w/none')).toEqual([])
  })

  it('removes the entry when links are cleared', async () => {
    const store = await createStore()
    store.setLineageManualLinks(PARENT, [{ id: 'l1', repoName: 'a', number: 1, addedAt: 1 }])
    store.setLineageManualLinks(PARENT, [])
    store.flush()

    const reloaded = await createStore()
    expect(reloaded.getLineageManualLinks(PARENT)).toEqual([])
  })

  it('loads a profile without the field as empty and drops malformed links', async () => {
    const store = await createStore()
    store.flush()
    expect((await createStore()).getLineageManualLinks(PARENT)).toEqual([])

    const good = { id: 'ok', repoName: 'r', number: 3, addedAt: 2 }
    writeDataFile({
      lineageManualLinksByParentKey: {
        [PARENT]: [
          good,
          { id: 1, repoName: 'r', number: 3 },
          { id: 'x', repoName: 'r', number: 0 }
        ],
        'not-an-array': 'bad'
      }
    })
    const reloaded = await createStore()
    expect(reloaded.getLineageManualLinks(PARENT)).toEqual([good])
  })

  it('drops entries whose parent key is not a workspace key', () => {
    const link = { id: 'ok', repoName: 'r', number: 3, addedAt: 2 }
    expect(
      normalizeManualLinks({
        [PARENT]: [link],
        'folder:f1': [link],
        'r1::/w/a': [link],
        'worktree:': [link],
        bogus: [link]
      })
    ).toEqual({ [PARENT]: [link], 'folder:f1': [link] })
  })

  it('round-trips branch and worktree links beside a legacy pull request link', async () => {
    const legacy = { id: 'p', repoName: 'loan-core', number: 12, addedAt: 1 }
    const branch = {
      id: 'b',
      kind: 'branch' as const,
      repoName: 'loan-core',
      repoId: 'r1',
      branch: 'feat/x',
      addedAt: 2
    }
    const worktree = {
      id: 'w',
      kind: 'worktree' as const,
      repoName: 'api',
      repoId: 'r2',
      worktreePath: '/w/api',
      worktreeId: 'r2::/w/api',
      addedAt: 3
    }
    const pr = { ...legacy, id: 'p2', kind: 'pr' as const, number: 13, branch: 'feat/y' }
    const store = await createStore()
    store.setLineageManualLinks(PARENT, [legacy, branch, worktree, pr])
    store.flush()

    const reloaded = await createStore()
    expect(reloaded.getLineageManualLinks(PARENT)).toEqual([legacy, branch, worktree, pr])
  })

  it('drops malformed links of every kind', () => {
    const ok = { id: 'ok', kind: 'branch', repoName: 'r', branch: 'b', addedAt: 1 }
    expect(
      normalizeManualLinks({
        [PARENT]: [
          ok,
          { id: 'a', kind: 'branch', repoName: 'r', addedAt: 1 },
          { id: 'b', kind: 'branch', repoName: 'r', branch: '', addedAt: 1 },
          { id: 'c', kind: 'worktree', repoName: 'r', addedAt: 1 },
          { id: 'd', kind: 'worktree', repoName: 'r', worktreePath: 7, addedAt: 1 },
          { id: 'e', kind: 'pr', repoName: 'r', addedAt: 1 },
          { id: 'f', kind: 'nonsense', repoName: 'r', number: 1, addedAt: 1 },
          { id: 'g', repoName: 'r', number: 1 },
          { id: 'h', repoName: 'r', number: 1, url: 5, addedAt: 1 },
          { id: '', repoName: 'r', number: 1, addedAt: 1 }
        ]
      })
    ).toEqual({ [PARENT]: [ok] })
  })

  it('dedupes per kind, repo and target, keeping the first', () => {
    const first = { id: 'a', repoName: 'Loan-Core', number: 1, addedAt: 1 }
    const branch = { id: 'b', kind: 'branch', repoName: 'loan-core', branch: 'x', addedAt: 1 }
    expect(
      normalizeManualLinks({
        [PARENT]: [
          first,
          { id: 'a2', kind: 'pr', repoName: 'loan-core', number: 1, addedAt: 2 },
          branch,
          { ...branch, id: 'b2' },
          { id: 'a', repoName: 'loan-core', number: 9, addedAt: 3 }
        ]
      })
    ).toEqual({ [PARENT]: [first, branch] })
  })

  it('defaults and persists lineageDiscovery settings', async () => {
    const store = await createStore()
    expect(store.getSettings().lineageDiscovery).toEqual(DEFAULT_LINEAGE_DISCOVERY)
    store.updateSettings({
      lineageDiscovery: {
        ...DEFAULT_LINEAGE_DISCOVERY,
        repoScope: ['loan-core']
      }
    })
    store.flush()

    const reloaded = await createStore()
    expect(reloaded.getSettings().lineageDiscovery?.repoScope).toEqual(['loan-core'])
  })
})
