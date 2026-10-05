import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProjectGroup } from '../../shared/project-group-types'

let home = ''
vi.mock('node:os', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  homedir: () => home
}))

import { ensureDefaultProjectGroupFolder } from './default-project-group-folder'

function makeGroup(overrides: Partial<ProjectGroup> = {}): ProjectGroup {
  return {
    id: 'abcdef123456',
    name: 'Platform',
    parentPath: null,
    parentGroupId: null,
    createdFrom: 'manual',
    tabOrder: 0,
    isCollapsed: false,
    color: null,
    createdAt: 0,
    updatedAt: 0,
    ...overrides
  }
}

describe('ensureDefaultProjectGroupFolder', () => {
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'orca-group-home-'))
  })
  afterEach(() => {
    rmSync(home, { recursive: true, force: true })
  })

  it('creates a folder under ~/Orca/groups and records it on the group', async () => {
    const update = vi.fn((_id: string, updates: { parentPath: string }) =>
      makeGroup({ parentPath: updates.parentPath })
    )

    const result = await ensureDefaultProjectGroupFolder(makeGroup(), update)

    expect(result.parentPath).toBe(join(home, 'Orca', 'groups', 'platform-abcdef12'))
    expect(statSync(result.parentPath!).isDirectory()).toBe(true)
  })

  it('leaves a group that already has a folder alone', async () => {
    const update = vi.fn()
    const group = makeGroup({ parentPath: '/work/platform' })

    await expect(ensureDefaultProjectGroupFolder(group, update)).resolves.toBe(group)
    expect(update).not.toHaveBeenCalled()
  })

  it('leaves a remote group alone because its folder must exist on that host', async () => {
    const update = vi.fn()
    const group = makeGroup({ connectionId: 'ssh-1' })

    await expect(ensureDefaultProjectGroupFolder(group, update)).resolves.toBe(group)
    expect(update).not.toHaveBeenCalled()
  })

  it('returns the group unchanged when the folder cannot be created', async () => {
    home = join(home, 'missing-file-parent')
    // Why: a file where the directory should go makes mkdir fail without needing root-only tricks.
    writeFileSync(home, 'x')
    const update = vi.fn()
    const group = makeGroup()

    await expect(ensureDefaultProjectGroupFolder(group, update)).resolves.toBe(group)
    expect(update).not.toHaveBeenCalled()
  })
})
