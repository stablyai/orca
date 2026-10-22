import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { closeTestStores, createStore, testState } from './persistence-test-harness'
import { hostWorktreeTarget } from '../shared/worktree/host-qualified-identity'
import type { DiffComment } from '../shared/diff-comment-types'

vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  safeStorage: { isEncryptionAvailable: () => false }
}))
vi.mock('./telemetry/client', () => ({ track: vi.fn() }))
vi.mock('./telemetry/cohort-classifier', () => ({ getCohortAtEmit: vi.fn() }))

const note = (id: string, body = id): DiffComment => ({
  id,
  worktreeId: 'review-workspace',
  filePath: 'README.md',
  lineNumber: 1,
  body,
  createdAt: 100,
  side: 'modified'
})

describe.each(['git', 'folder'] as const)('%s workspace review-note concurrency', (kind) => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-review-notes-'))
  })
  afterEach(async () => {
    await closeTestStores()
    rmSync(testState.dir, { recursive: true, force: true })
  })

  function setup() {
    const store = createStore()
    const group = store.createProjectGroup({
      name: 'Docs',
      parentPath: '/docs',
      createdFrom: 'manual'
    })
    const folder = store.createFolderWorkspace({ projectGroupId: group.id })
    const target = hostWorktreeTarget({ id: 'review-workspace', hostId: 'local' })
    const read = () =>
      kind === 'git'
        ? store.getWorktreeMetaForHost(target.id, target.hostId)
        : store.getFolderWorkspace(folder.id)
    const write = (diffComments: DiffComment[], diffCommentsBase?: DiffComment[]) => {
      const updates = {
        diffComments,
        ...(diffCommentsBase !== undefined ? { diffCommentsBase } : {})
      }
      return kind === 'git'
        ? store.setWorktreeMeta(target, updates)
        : store.updateFolderWorkspace(folder.id, updates)
    }
    write([note('A')])
    return { store, folder, target, read, write }
  }

  it('preserves another client’s additions across a stale add and delete', () => {
    const { read, write } = setup()
    const baseline = [...(read()?.diffComments ?? [])]
    write([...baseline, note('B')], baseline)
    write([note('C')], baseline)
    expect(read()?.diffComments).toEqual([note('B'), note('C')])
    expect(read()).not.toHaveProperty('diffCommentsBase')
  })

  it('does not resurrect a deleted note from an unchanged stale baseline', () => {
    const { read, write } = setup()
    const baseline = [...(read()?.diffComments ?? [])]
    write([], baseline)
    write([...baseline, note('C')], baseline)
    expect(read()?.diffComments).toEqual([note('C')])
  })

  it.each(['edit', 'delete'] as const)(
    'rejects a conflicting %s without losing the remote edit',
    (action) => {
      const { read, write } = setup()
      const baseline = [...(read()?.diffComments ?? [])]
      write([note('A', 'Desktop edit')], baseline)
      expect(() => write(action === 'edit' ? [note('A', 'Phone edit')] : [], baseline)).toThrow(
        /Review notes changed/
      )
      expect(read()?.diffComments).toEqual([note('A', 'Desktop edit')])
    }
  )

  it('rejects an edit after another client deleted the note', () => {
    const { read, write } = setup()
    const baseline = [...(read()?.diffComments ?? [])]
    write([], baseline)
    expect(() => write([note('A', 'Phone edit')], baseline)).toThrow(/Review notes changed/)
    expect(read()?.diffComments).toEqual([])
  })

  it('persists the merged list without persisting a mutation baseline', () => {
    const { store, folder, target, read, write } = setup()
    const baseline = [...(read()?.diffComments ?? [])]
    write([...baseline, note('B')], baseline)
    write([...baseline, note('C')], baseline)
    store.flush()
    const restored = createStore()
    const record =
      kind === 'git'
        ? restored.getWorktreeMetaForHost(target.id, target.hostId)
        : restored.getFolderWorkspace(folder.id)
    expect(record?.diffComments).toEqual([note('A'), note('B'), note('C')])
    expect(record).not.toHaveProperty('diffCommentsBase')
  })

  it('preserves legacy replacement semantics for clients without a baseline', () => {
    const { read, write } = setup()
    write([note('Legacy')])
    expect(read()?.diffComments).toEqual([note('Legacy')])
  })
})
