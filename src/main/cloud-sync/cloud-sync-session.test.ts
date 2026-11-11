import { chmod, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CloudSyncState } from '../../shared/cloud-sync/cloud-sync-contract'
import { createFakeVm, VM_ROOT, type FakeVm } from './cloud-sync-fake-vm.test-support'
import { safetyIntervalMs } from './cloud-sync-plan'
import { createCloudSyncSession } from './cloud-sync-session'
import { createCloudSyncStore, type CloudSyncChoice } from './cloud-sync-store'

const dirs: string[] = []
afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function setup(vm: FakeVm, choice: CloudSyncChoice = { context: true, mirror: false }) {
  const folder = await mkdtemp(join(tmpdir(), 'cloud-sync-folder-'))
  const userData = await mkdtemp(join(tmpdir(), 'cloud-sync-userdata-'))
  dirs.push(folder, userData)
  const store = createCloudSyncStore(userData)
  const states: CloudSyncState[] = []
  const session = createCloudSyncSession({
    workspaceId: 'ws',
    folder,
    projectRoot: VM_ROOT,
    call: vm.call,
    subscribeWatch: vm.subscribe,
    store,
    choice,
    emit: (state) => states.push(state)
  })
  return { folder, store, states, session, last: () => states.at(-1)! }
}

const settle = async (session: { resync: () => Promise<void> }): Promise<void> => {
  await session.resync()
}

describe('cloud sync session', () => {
  it('copies .context (gitignored, walked) read-only and leaves other files alone by default', async () => {
    const vm = createFakeVm()
    vm.write('.context/plan.md', '# Plan')
    vm.write('.context/shots/one.png', 'PNG')
    vm.write('src/index.ts', 'code')
    const { folder, session, last } = await setup(vm)
    await session.start()
    expect(await readFile(join(folder, '.context/plan.md'), 'utf8')).toBe('# Plan')
    expect(await readFile(join(folder, '.context/shots/one.png'), 'utf8')).toBe('PNG')
    await expect(stat(join(folder, 'src/index.ts'))).rejects.toThrow()
    expect((await stat(join(folder, '.context/plan.md'))).mode & 0o222).toBe(0)
    expect(last()).toMatchObject({ phase: 'synced', files: 2, editedHere: 0 })
    await session.stop()
  })

  it('mirrors the workspace minus .gitignore, then removes it when the mirror is turned off', async () => {
    const vm = createFakeVm()
    vm.write('.context/plan.md', 'p')
    vm.write('src/index.ts', 'code')
    vm.write('dist/bundle.js', 'built')
    vm.ignored.add('dist/bundle.js')
    const { folder, session, last } = await setup(vm, { context: true, mirror: true })
    await session.start()
    expect(await readFile(join(folder, 'src/index.ts'), 'utf8')).toBe('code')
    await expect(stat(join(folder, 'dist/bundle.js'))).rejects.toThrow()
    expect(last()).toMatchObject({ phase: 'synced', files: 2 })
    await session.setChoice({ context: true, mirror: false })
    await expect(stat(join(folder, 'src/index.ts'))).rejects.toThrow()
    // The emptied directory goes too; .context stays.
    await expect(stat(join(folder, 'src'))).rejects.toThrow()
    expect(await readFile(join(folder, '.context/plan.md'), 'utf8')).toBe('p')
    await session.stop()
  })

  it('second pass is incremental: only changed files are read again', async () => {
    const vm = createFakeVm()
    for (let i = 0; i < 50; i++) {
      vm.write(`src/f${i}.ts`, `v${i}`)
    }
    const { folder, session } = await setup(vm, { context: true, mirror: true })
    await session.start()
    vm.calls.length = 0
    vm.write('src/f7.ts', 'changed')
    await settle(session)
    expect(vm.calls.filter((method) => method === 'files.readChunk')).toHaveLength(1)
    expect(vm.calls.filter((method) => method === 'files.statMany')).toHaveLength(1)
    expect(await readFile(join(folder, 'src/f7.ts'), 'utf8')).toBe('changed')
    await session.stop()
  })

  it('follows the cloud file watch: changes and deletions land without a full pass', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const vm = createFakeVm()
    vm.write('.context/plan.md', 'v1')
    const { folder, session } = await setup(vm)
    await session.start()
    vm.calls.length = 0
    vm.write('.context/plan.md', 'v2')
    vm.write('.context/new.png', 'img')
    vm.emitWatch([
      { kind: 'update', absolutePath: `${VM_ROOT}/.context/plan.md` },
      { kind: 'create', absolutePath: `${VM_ROOT}/.context/new.png` },
      // Outside the workspace: ignored.
      { kind: 'update', absolutePath: '/etc/passwd' }
    ])
    await vi.advanceTimersByTimeAsync(1_000)
    vi.useRealTimers()
    await vi.waitFor(async () =>
      expect(await readFile(join(folder, '.context/new.png'), 'utf8')).toBe('img')
    )
    expect(await readFile(join(folder, '.context/plan.md'), 'utf8')).toBe('v2')
    // Targeted: no walk of .context, one stat batch, one read per file.
    expect(vm.calls).not.toContain('files.readDir')
    expect(vm.calls.filter((method) => method === 'files.statMany')).toHaveLength(1)
    expect(vm.calls.filter((method) => method === 'files.readChunk')).toHaveLength(2)
    await session.stop()
  })

  it('a watch delete removes the copy', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const vm = createFakeVm()
    vm.write('.context/a.md', 'a')
    vm.write('.context/b.md', 'b')
    const { folder, session } = await setup(vm)
    await session.start()
    vm.remove('.context/a.md')
    vm.emitWatch([{ kind: 'delete', absolutePath: `${VM_ROOT}/.context/a.md` }])
    await vi.advanceTimersByTimeAsync(1_000)
    vi.useRealTimers()
    await vi.waitFor(async () => expect(stat(join(folder, '.context/a.md'))).rejects.toThrow())
    expect(await readFile(join(folder, '.context/b.md'), 'utf8')).toBe('b')
    await session.stop()
  })

  it('keeps a forced local edit, reports it, and replaces it when the cloud changes', async () => {
    const vm = createFakeVm()
    vm.write('.context/plan.md', 'cloud')
    const { folder, session, last } = await setup(vm)
    await session.start()
    const path = join(folder, '.context/plan.md')
    await chmod(path, 0o644)
    await writeFile(path, 'edited here, longer')
    await settle(session)
    expect(await readFile(path, 'utf8')).toBe('edited here, longer')
    expect(last().editedHere).toBe(1)
    vm.write('.context/plan.md', 'cloud v2')
    await settle(session)
    expect(await readFile(path, 'utf8')).toBe('cloud v2')
    expect(last().editedHere).toBe(0)
    await session.stop()
  })

  it('never removes files it did not copy', async () => {
    const vm = createFakeVm()
    vm.write('.context/plan.md', 'p')
    const { folder, session } = await setup(vm)
    await session.start()
    await writeFile(join(folder, '.context/mine.txt'), 'local only')
    await settle(session)
    expect(await readFile(join(folder, '.context/mine.txt'), 'utf8')).toBe('local only')
    await session.stop()
  })

  it('does not write through a symlink planted in the folder', async () => {
    const vm = createFakeVm()
    vm.write('.context/sub/plan.md', 'p')
    const { folder, session } = await setup(vm)
    const outside = await mkdtemp(join(tmpdir(), 'cloud-sync-outside-'))
    dirs.push(outside)
    const { mkdir } = await import('node:fs/promises')
    await mkdir(join(folder, '.context'))
    await symlink(outside, join(folder, '.context/sub'))
    await session.start()
    await expect(stat(join(outside, 'plan.md'))).rejects.toThrow()
    await session.stop()
  })

  it('falls back to one stat per file on an older sandbox image', async () => {
    const vm = createFakeVm()
    vm.statManySupported = false
    vm.write('.context/a.md', 'a')
    vm.write('.context/b.md', 'b')
    const { folder, session } = await setup(vm)
    await session.start()
    expect(vm.calls.filter((method) => method === 'files.stat').length).toBeGreaterThanOrEqual(2)
    expect(await readFile(join(folder, '.context/b.md'), 'utf8')).toBe('b')
    await session.stop()
  })

  it('reads an asleep sandbox as waiting, not as an error', async () => {
    const vm = createFakeVm()
    vm.asleep = true
    const { session, last } = await setup(vm)
    await session.start()
    expect(last()).toMatchObject({ phase: 'waiting', error: null })
    await session.stop()
  })

  it('skips files over the per-file limit and says so', async () => {
    const vm = createFakeVm()
    vm.files.set('.context/huge.mov', { content: Buffer.alloc(51_000_000), mtime: 1 })
    vm.write('.context/plan.md', 'p')
    const { folder, session, last } = await setup(vm)
    await session.start()
    await expect(stat(join(folder, '.context/huge.mov'))).rejects.toThrow()
    expect(last()).toMatchObject({ phase: 'synced', files: 1, skippedLarge: 1 })
    await session.stop()
  })

  it('stops cleanly: closes the watch and leaves the files', async () => {
    const vm = createFakeVm()
    vm.write('.context/plan.md', 'p')
    const { folder, session } = await setup(vm)
    await session.start()
    expect(vm.openWatches()).toBe(1)
    await session.stop()
    expect(vm.openWatches()).toBe(0)
    expect(await readFile(join(folder, '.context/plan.md'), 'utf8')).toBe('p')
  })
})

describe('safetyIntervalMs', () => {
  it('re-checks small folders every 30 s and large mirrors at most every 10 min', () => {
    expect(safetyIntervalMs(0)).toBe(30_000)
    expect(safetyIntervalMs(21)).toBe(30_000)
    expect(safetyIntervalMs(2_000)).toBe(60_000)
    expect(safetyIntervalMs(100_000)).toBe(600_000)
    // A 20 s manifest (no files.statMany on the image) waits 400 s: at most 5% of the time.
    expect(safetyIntervalMs(2_000, 20_000)).toBe(400_000)
  })
})
