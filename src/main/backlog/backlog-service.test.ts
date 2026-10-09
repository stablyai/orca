import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm, symlink, readFile, cp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { executeBacklogOperation } from './backlog-service'
import { backlogMutationArgs } from './backlog-cli'
import * as backlogCli from './backlog-cli'
import { BacklogOperation } from '../../shared/backlog-types'
import { runProcess } from '../../shared/child-process/run-process'

const roots: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
/** Creates an isolated project with automatic commits, remote scans and branch checks disabled. */
async function fixture(directory = 'backlog') {
  const root = await mkdtemp(path.join(tmpdir(), 'orca-backlog-'))
  roots.push(root)
  await mkdir(path.join(root, directory, 'tasks'), { recursive: true })
  await writeFile(
    path.join(root, 'backlog.config.yml'),
    `project_name: Sample\nbacklog_directory: ${directory}\nstatuses: [Inbox, "In review", Released]\nremote_operations: false\ncheck_active_branches: false\nauto_commit: false\n`
  )
  return root
}
/** Seeds a lowercase filename and structured body to detect ID lookup and CLI-edit data loss. */
async function task(root: string, id: string, status = 'In review', directory = 'backlog') {
  await writeFile(
    path.join(root, directory, 'tasks', `${id.toLowerCase()} - sample.md`),
    `---\nid: ${id}\ntitle: "Unicode café: task"\nstatus: ${status}\n---\n## Description\n<!-- SECTION:DESCRIPTION:BEGIN -->\nLine one\nLine two\n<!-- SECTION:DESCRIPTION:END -->\n\n## Acceptance Criteria\n- [ ] Preserve this\n`
  )
}

describe('Backlog project operations', () => {
  it.each(['backlog', '.backlog', 'planning/work'])(
    'reads configured IDs, statuses and complete details in %s',
    async (directory) => {
      const root = await fixture(directory)
      await task(root, 'OPS-007.2', 'In review', directory)
      await task(root, 'OPS-008', 'Released', directory)
      const list = await executeBacklogOperation(root, {
        kind: 'list',
        search: 'café',
        status: 'In review',
        offset: 0
      })
      expect(list).toMatchObject({
        statuses: ['Inbox', 'In review', 'Released'],
        total: 1,
        tasks: [{ id: 'OPS-007.2', status: 'In review' }]
      })
      expect(list).toHaveProperty(
        'mutationUnavailable',
        expect.stringContaining('backlog.md@1.48.0')
      )
      const detail = await executeBacklogOperation(root, { kind: 'read', id: 'OPS-007.2' })
      expect(detail).toMatchObject({
        description: 'Line one\nLine two',
        body: expect.stringContaining('Preserve this')
      })
    }
  )
  it('preserves the configuration reason when the CLI is also unavailable', async () => {
    const root = await fixture()
    await writeFile(
      path.join(root, 'backlog.config.yml'),
      'project_name: Sample\nbacklog_directory: backlog\nauto_commit: true\n'
    )
    const resolveCli = vi.spyOn(backlogCli, 'resolveBacklogCli')
    expect(
      await executeBacklogOperation(root, { kind: 'list', search: '', status: '', offset: 0 })
    ).toHaveProperty('mutationUnavailable', expect.stringContaining('Disable Backlog autoCommit'))
    expect(resolveCli).not.toHaveBeenCalled()
  })
  it('rejects a new unconfigured status even when the old status is unconfigured', async () => {
    const root = await fixture()
    await task(root, 'OPS-1', 'Legacy')
    await expect(
      executeBacklogOperation(root, {
        kind: 'edit',
        id: 'OPS-1',
        title: 'Changed',
        description: '',
        status: 'Unknown'
      })
    ).rejects.toThrow('configured Backlog status')
  })
  it('rejects a missing config, traversal, and duplicate IDs', async () => {
    const root = await fixture()
    await rm(path.join(root, 'backlog.config.yml'))
    await expect(
      executeBacklogOperation(root, { kind: 'list', search: '', status: '', offset: 0 })
    ).rejects.toThrow('No Backlog.md configuration')
    await writeFile(
      path.join(root, 'backlog.config.yml'),
      'project_name: Bad\nbacklog_directory: ../escape\n'
    )
    await expect(
      executeBacklogOperation(root, { kind: 'list', search: '', status: '', offset: 0 })
    ).rejects.toThrow('traversal')
    const valid = await fixture()
    await task(valid, 'OPS-1')
    await cp(
      path.join(valid, 'backlog/tasks/ops-1 - sample.md'),
      path.join(valid, 'backlog/tasks/ops-1 - duplicate.md')
    )
    await expect(
      executeBacklogOperation(valid, { kind: 'list', search: '', status: '', offset: 0 })
    ).rejects.toThrow('Duplicate')
  })
  it('refuses symlinked task files and directories', async () => {
    const root = await fixture()
    const outside = await fixture()
    await task(outside, 'OPS-1')
    await symlink(
      path.join(outside, 'backlog/tasks/ops-1 - sample.md'),
      path.join(root, 'backlog/tasks/ops-1 - sample.md')
    )
    await expect(executeBacklogOperation(root, { kind: 'read', id: 'OPS-1' })).rejects.toThrow(
      'symlink'
    )
    await rm(path.join(root, 'backlog/tasks'), { recursive: true })
    await symlink(path.join(outside, 'backlog/tasks'), path.join(root, 'backlog/tasks'), 'junction')
    await expect(executeBacklogOperation(root, { kind: 'read', id: 'OPS-1' })).rejects.toThrow(
      'symlink'
    )
  })
  it('caps task reads and list pages', async () => {
    const root = await fixture()
    for (let index = 0; index < 103; index++) {
      await task(root, `OPS-${index}`)
    }
    const page = await executeBacklogOperation(root, {
      kind: 'list',
      search: '',
      status: '',
      offset: 100
    })
    expect(page).toMatchObject({
      total: 103,
      tasks: [{ id: 'OPS-100' }, { id: 'OPS-101' }, { id: 'OPS-102' }]
    })
    await writeFile(path.join(root, 'backlog/tasks/huge.md'), 'x'.repeat(131073))
    await expect(
      executeBacklogOperation(root, { kind: 'list', search: '', status: '', offset: 0 })
    ).rejects.toThrow('limit')
  })
  it('refuses mutations without the CLI or with executable hooks/autocommit', async () => {
    const root = await fixture()
    const create = { kind: 'create', title: 'Task', description: '', status: 'Inbox' } as const
    await expect(executeBacklogOperation(root, create)).rejects.toThrow('Install backlog.md@1.48.0')
    await writeFile(
      path.join(root, 'backlog.config.yml'),
      'project_name: Sample\nbacklog_directory: backlog\nauto_commit: true\n'
    )
    await expect(executeBacklogOperation(root, create)).rejects.toThrow(
      'Disable Backlog autoCommit'
    )
  })
  it('rejects padded-ID collisions and hidden CLI configuration effects', async () => {
    const root = await fixture()
    await task(root, 'OPS-01')
    await task(root, 'OPS-1')
    await expect(
      executeBacklogOperation(root, { kind: 'list', search: '', status: '', offset: 0 })
    ).rejects.toThrow('Duplicate')
    await rm(path.join(root, 'backlog/tasks/ops-1 - sample.md'))
    await writeFile(
      path.join(root, 'backlog.config.yml'),
      'project_name: Sample\nbacklog_directory: backlog\nremote_operations: false\ncheck_active_branches: false\nnotes: |\n  auto_commit: true\n'
    )
    await expect(
      executeBacklogOperation(root, {
        kind: 'edit',
        id: 'OPS-01',
        title: 'Task',
        description: '',
        status: 'To Do'
      })
    ).rejects.toThrow('Disable Backlog autoCommit')
  })

  it('keeps shell and option syntax inside argv values', () => {
    const text = '--help; $(touch nope)\n%PATH% & `echo nope`'
    expect(
      backlogMutationArgs({ kind: 'create', title: text, description: text, status: 'In review' })
    ).toEqual([
      'task',
      'create',
      `--description=${text}`,
      '--status=In review',
      '--plain',
      '--',
      text
    ])
    expect(
      backlogMutationArgs({
        kind: 'edit',
        id: 'OPS-007.2',
        title: text,
        description: '',
        status: 'Inbox'
      })
    ).toEqual([
      'task',
      'edit',
      'OPS-007.2',
      `--title=${text}`,
      '--description=',
      '--status=Inbox',
      '--plain'
    ])
    expect(BacklogOperation.safeParse({ kind: 'read', id: '../OPS-1' }).success).toBe(false)
    expect(
      BacklogOperation.safeParse({
        kind: 'create',
        title: 'bad\0arg',
        description: '',
        status: 'Inbox'
      }).success
    ).toBe(false)
  })
})

// Set to a public backlog.md@1.48.0 package installation; all writes stay in the fixture copy.
it.skipIf(!process.env.ORCA_BACKLOG_TEST_PACKAGE)(
  'creates and edits through the real pinned CLI without losing other task sections',
  async () => {
    const source = process.env.ORCA_BACKLOG_TEST_PACKAGE!
    const root = await fixture()
    await mkdir(path.join(root, 'node_modules'), { recursive: true })
    await cp(source, path.join(root, 'node_modules/backlog.md'), {
      recursive: true,
      dereference: true
    })
    const nativePackage = `backlog.md-${process.platform === 'win32' ? 'windows' : process.platform}-${process.arch}`
    await cp(
      path.join(path.dirname(source), nativePackage),
      path.join(root, 'node_modules', nativePackage),
      { recursive: true, dereference: true }
    )
    await task(root, 'TASK-001', 'Legacy')
    const legacyFile = path.join(root, 'backlog/tasks/task-001 - sample.md')
    await writeFile(
      legacyFile,
      (await readFile(legacyFile, 'utf8'))
        .replace('<!-- SECTION:DESCRIPTION:BEGIN -->\n', '')
        .replace('\n<!-- SECTION:DESCRIPTION:END -->', '')
    )
    const legacy = await executeBacklogOperation(root, { kind: 'read', id: 'TASK-001' })
    expect(legacy).toMatchObject({ description: 'Line one\nLine two' })
    if (!('body' in legacy)) {
      throw new Error('Expected task detail')
    }
    expect(backlogMutationArgs({ kind: 'edit', ...legacy, title: 'Title only' }, legacy)).toEqual([
      'task',
      'edit',
      'TASK-001',
      '--title=Title only',
      '--plain'
    ])
    await executeBacklogOperation(root, { kind: 'edit', ...legacy, title: 'Title only' })
    expect(await executeBacklogOperation(root, { kind: 'read', id: 'TASK-001' })).toMatchObject({
      description: 'Line one\nLine two',
      status: 'Legacy',
      body: expect.stringContaining('Preserve this')
    })
    await executeBacklogOperation(root, {
      kind: 'edit',
      ...legacy,
      title: 'Title only',
      description: 'Description only'
    })
    expect(await executeBacklogOperation(root, { kind: 'read', id: 'TASK-001' })).toMatchObject({
      title: 'Title only',
      description: 'Description only',
      status: 'Legacy',
      body: expect.stringContaining('Preserve this')
    })
    await executeBacklogOperation(root, {
      kind: 'edit',
      id: 'TASK-001',
      title: '--help; $(echo nope)',
      description: 'New\nparagraph',
      status: 'Released'
    })
    const edited = await executeBacklogOperation(root, { kind: 'read', id: 'TASK-001' })
    expect(edited).toMatchObject({
      title: '--help; $(echo nope)',
      description: 'New\nparagraph',
      status: 'Released',
      body: expect.stringContaining('Preserve this')
    })
    await executeBacklogOperation(root, {
      kind: 'create',
      title: '--literal title',
      description: 'Created by CLI',
      status: 'Inbox'
    })
    const list = await executeBacklogOperation(root, {
      kind: 'list',
      search: '--literal title',
      status: '',
      offset: 0
    })
    expect(list).toMatchObject({ total: 1, tasks: [{ title: '--literal title', status: 'Inbox' }] })
    const version = await runProcess({
      program: process.execPath,
      args: [path.join(root, 'node_modules/backlog.md/cli.js'), '--version'],
      cwd: root
    })
    expect(version.stdout.trim()).toBe('1.48.0')
    expect(await readFile(path.join(root, 'backlog.config.yml'), 'utf8')).toContain(
      'auto_commit: false'
    )
  }
)
