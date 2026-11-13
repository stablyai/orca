import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  closeTestStores,
  createStore,
  makeRepo,
  testState,
  writeDataFile
} from '../../persistence/persistence-test-harness'
import { getWorkspaceAttachments } from '../../../shared/workspace-attachments/workspace-attachments'
import { hostWorktreeTarget } from '../../../shared/worktree/host-qualified-identity'
import { installGitHubIssueLinkTitleFill } from './github-issue-link-title-fill'

vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: { isEncryptionAvailable: () => false }
}))
vi.mock('../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../telemetry/cohort-classifier', () => ({ getCohortAtEmit: vi.fn() }))

const target = hostWorktreeTarget({ id: 'repo::/work', hostId: 'local' })

async function setup(readIssueTitle: () => Promise<string | null>) {
  writeDataFile({ repos: [makeRepo({ id: 'repo', path: '/work' })] })
  const store = await createStore()
  const pending: (() => void)[] = []
  const publish = vi.fn()
  installGitHubIssueLinkTitleFill({
    store,
    readIssueTitle,
    publish,
    schedule: (run) => pending.push(run)
  })
  const settle = async (): Promise<void> => {
    for (const run of pending.splice(0)) {
      run()
    }
    await vi.waitFor(() => expect(readIssueTitle).toHaveBeenCalled())
    await new Promise((resolve) => setImmediate(resolve))
  }
  return { store, settle, publish }
}

describe('GitHub issue link title fill', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-issue-link-title-'))
  })
  afterEach(async () => {
    await closeTestStores()
    rmSync(testState.dir, { recursive: true, force: true })
  })

  it('titles a bare linked issue without re-selecting a review the user had cleared', async () => {
    const { store, settle, publish } = await setup(vi.fn(async () => 'Repair authentication'))
    // A kept merge request with no review selected, as after the user clears the selection.
    store.setWorktreeMeta(target, {
      linkedItems: [{ provider: 'gitlab', type: 'mr', number: 5 }],
      linkedPR: null,
      linkedGitLabMR: null,
      linkedBitbucketPR: null,
      linkedAzureDevOpsPR: null,
      linkedGiteaPR: null
    })
    store.setWorktreeMeta(target, { linkedIssue: 42 })
    expect(store.getWorktreeMetaForHost('repo::/work', 'local')?.linkedGitLabMR ?? null).toBeNull()
    await settle()

    const meta = store.getWorktreeMetaForHost('repo::/work', 'local')
    expect(getWorkspaceAttachments(meta)).toContainEqual(
      expect.objectContaining({
        provider: 'github',
        type: 'issue',
        number: 42,
        title: 'Repair authentication'
      })
    )
    expect(meta?.linkedIssue).toBe(42)
    expect(meta?.linkedGitLabMR ?? null).toBeNull()
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({ worktreeId: 'repo::/work', hostId: 'local' })
    )
  })

  it('does not bring back a link removed while its title was being read', async () => {
    let finish: (title: string) => void = () => {}
    const read = vi.fn(() => new Promise<string | null>((resolve) => (finish = resolve)))
    const { store, settle } = await setup(read)
    store.setWorktreeMeta(target, { linkedIssue: 42 })
    const settled = settle()
    await vi.waitFor(() => expect(read).toHaveBeenCalled())
    store.setWorktreeMeta(target, { linkedIssue: null })
    finish('Repair authentication')
    await settled

    const links = getWorkspaceAttachments(store.getWorktreeMetaForHost('repo::/work', 'local'))
    expect(links.filter((item) => item.provider === 'github' && item.type === 'issue')).toEqual([])
  })
})
