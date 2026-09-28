import type * as FileSystem from 'node:fs/promises'
import {
  mkdtemp,
  mkdir,
  readdir,
  rm,
  symlink,
  writeFile,
  realpath,
  readFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { acquireProfileStateRuntimeAdmission } from '../persistence/profile-state/profile-state-access'
import {
  acquireDaemonRuntimeLaunchPin,
  collectPinnedDaemonRuntimeDirectories,
  MANAGED_DAEMON_RUNTIME_DIRECTORY,
  pruneDaemonBunRuntimes
} from './daemon-bun-runtime-retention'

const { removingTrash } = vi.hoisted(() => ({ removingTrash: vi.fn() }))
vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof FileSystem>()
  return {
    ...fs,
    rm: async (...args: Parameters<typeof fs.rm>) => {
      if (String(args[0]).includes('.bun-trash-')) {
        await removingTrash()
      }
      return fs.rm(...args)
    }
  }
})
const { snapshot, available, identities } = vi.hoisted(() => ({
  snapshot: vi.fn(),
  available: vi.fn(),
  identities: vi.fn()
}))
vi.mock('../windows/windows-process-table', () => ({
  readWindowsProcessTableFresh: snapshot,
  isWindowsProcessTableAvailable: available,
  isWindowsProcessStartTimeAvailable: identities,
  readWindowsProcessCreationTime: () => null
}))
const roots: string[] = []
beforeEach(() => {
  removingTrash.mockReset().mockResolvedValue(undefined)
  snapshot.mockReset().mockResolvedValue([])
  available.mockReturnValue(true)
  identities.mockReturnValue(true)
})
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
async function fixture(count = 8) {
  const host = await realpath(await mkdtemp(join(tmpdir(), 'bun-retention-')))
  roots.push(host)
  const root = join(host, MANAGED_DAEMON_RUNTIME_DIRECTORY)
  await mkdir(root)
  const paths: string[] = []
  for (let i = 0; i < count; i++) {
    const path = join(root, `bun-${i.toString(16).padStart(64, '0')}`)
    await mkdir(path)
    await writeFile(join(path, 'daemon-entry.js'), 'entry')
    paths.push(path)
  }
  return { host, root, paths }
}
async function generations(root: string) {
  return (await readdir(root)).filter((name) => name.startsWith('bun-'))
}
describe('managed Windows daemon runtime retention', () => {
  it('bounds each pass and retains two unused generations without touching legacy paths', async () => {
    const { host, root } = await fixture()
    await mkdir(join(host, 'legacy-version'))
    await pruneDaemonBunRuntimes(host)
    expect(await generations(root)).toHaveLength(4)
    await pruneDaemonBunRuntimes(host)
    expect(await generations(root)).toHaveLength(2)
    expect(await readdir(host)).toContain('legacy-version')
  })
  it('excludes pruning while any profile is resolving or launching', async () => {
    const { host, root } = await fixture()
    const first = await acquireDaemonRuntimeLaunchPin(root)
    const second = await acquireDaemonRuntimeLaunchPin(root)
    first.release()
    await pruneDaemonBunRuntimes(host)
    expect(snapshot).not.toHaveBeenCalled()
    expect(await generations(root)).toHaveLength(8)
    second.release()
    await pruneDaemonBunRuntimes(host)
    expect(await generations(root)).toHaveLength(4)
  })
  it('a launch waits for the exclusive snapshot to finish', async () => {
    const { host, root } = await fixture()
    let finish: (() => void) | undefined
    snapshot.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = () => resolve([])
        })
    )
    const pruning = pruneDaemonBunRuntimes(host)
    await vi.waitFor(() => expect(snapshot).toHaveBeenCalled())
    let admitted = false
    const launching = acquireDaemonRuntimeLaunchPin(root).then((pin) => {
      admitted = true
      return pin
    })
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(admitted).toBe(false)
    finish?.()
    await pruning
    ;(await launching).release()
  })
  it('admits launches while retired files are still being deleted', async () => {
    const { host, root } = await fixture()
    let finish: (() => void) | undefined
    removingTrash.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve
        })
    )
    const pruning = pruneDaemonBunRuntimes(host)
    await vi.waitFor(() => expect(removingTrash).toHaveBeenCalled())
    const pin = await acquireDaemonRuntimeLaunchPin(root)
    try {
      expect(await generations(root)).toHaveLength(4)
      expect((await readdir(root)).some((name) => name.startsWith('.bun-trash-'))).toBe(true)
    } finally {
      pin.release()
      finish?.()
      await pruning
    }
    expect((await readdir(root)).some((name) => name.startsWith('.bun-trash-'))).toBe(false)
  })
  it('retries deletion of retired directories left by interrupted pruning', async () => {
    const { host, root } = await fixture(0)
    const trash = join(root, '.bun-trash-12345678-1234-1234-1234-123456789abc')
    await mkdir(trash)
    await writeFile(join(trash, 'daemon-entry.js'), 'entry')
    await pruneDaemonBunRuntimes(host)
    expect((await readdir(root)).filter((name) => name.startsWith('.bun-trash-'))).toEqual([])
  })
  it.each(['bun-runtime.exe', 'bun.exe', 'OpenConsole.exe'])(
    'retains live %s closures',
    async (name) => {
      const { host, root, paths } = await fixture(4)
      snapshot.mockResolvedValue(
        paths.map((path, index) => ({
          pid: index + 100,
          ppid: 1,
          name,
          creationTimeMs: 100,
          command: `"C:${path.replaceAll('/', '\\')}\\${name}"`
        }))
      )
      await pruneDaemonBunRuntimes(host)
      expect(await generations(root)).toHaveLength(4)
    }
  )
  it.each([
    { command: '', creationTimeMs: 100 },
    { command: 'bun-runtime.exe daemon-entry.js', creationTimeMs: 100 },
    { command: '"C:\\elsewhere\\bun.exe"', creationTimeMs: undefined }
  ])('preserves all files when a relevant owner is unverifiable: %j', async (row) => {
    const { host, root } = await fixture()
    snapshot.mockResolvedValue([{ pid: 100, ppid: 1, name: 'bun-runtime.exe', ...row }])
    await pruneDaemonBunRuntimes(host)
    expect(await generations(root)).toHaveLength(8)
  })
  it('preserves everything when the snapshot fails or creation-time support is missing', async () => {
    const { host, root } = await fixture()
    snapshot.mockRejectedValue(new Error('unavailable'))
    await pruneDaemonBunRuntimes(host)
    expect(await generations(root)).toHaveLength(8)
    snapshot.mockClear()
    identities.mockReturnValue(false)
    await pruneDaemonBunRuntimes(host)
    expect(snapshot).not.toHaveBeenCalled()
  })
  it('cleans staging only under exclusive ownership, regardless of its age', async () => {
    const { host, root } = await fixture(0)
    const name = '.bun-staging-12345678-1234-1234-1234-123456789abc'
    await mkdir(join(root, name))
    const pin = acquireProfileStateRuntimeAdmission(root)
    await pruneDaemonBunRuntimes(host)
    expect(await readdir(root)).toContain(name)
    pin.release()
    await pruneDaemonBunRuntimes(host)
    expect(await readdir(root)).not.toContain(name)
  })
  it('does not traverse symlinked generations or roots', async () => {
    const { host, root } = await fixture(0)
    const external = await mkdtemp(join(tmpdir(), 'bun-external-'))
    roots.push(external)
    await writeFile(join(external, 'precious'), 'live')
    await symlink(external, join(root, `bun-${'a'.repeat(64)}`), 'dir')
    await pruneDaemonBunRuntimes(host)
    expect(await readdir(external)).toEqual(['precious'])
    await rm(root, { recursive: true })
    await symlink(external, root, 'dir')
    snapshot.mockClear()
    await pruneDaemonBunRuntimes(host)
    expect(snapshot).not.toHaveBeenCalled()
  })
  it('reclaims a pin only when its recorded process has exited', async () => {
    const { host, root } = await fixture()
    acquireProfileStateRuntimeAdmission(root)
    const participants = join(root, '.profile-state-access', 'participants')
    const [owner] = await readdir(participants)
    const path = join(participants, owner, `${owner}.owner`)
    const record = JSON.parse(await readFile(path, 'utf8'))
    await writeFile(path, JSON.stringify({ ...record, pid: 2147483647 }))
    await pruneDaemonBunRuntimes(host)
    expect(await generations(root)).toHaveLength(4)
    expect(await readdir(participants)).toEqual([])
  })
  it('preserves malformed stale launch owners rather than stealing them by age', async () => {
    const { host, root } = await fixture()
    const pin = acquireProfileStateRuntimeAdmission(root)
    const participants = join(root, '.profile-state-access', 'participants')
    const [owner] = await readdir(participants)
    await writeFile(join(participants, owner, `${owner}.owner`), '{}')
    await pruneDaemonBunRuntimes(host)
    expect(await generations(root)).toHaveLength(8)
    // The malformed owner is retained deliberately; the fixture removes it after the test.
    expect(pin).toBeDefined()
  })
})

describe('runtime executable aliases', () => {
  const directory = 'C:\\Users\\Owner Name\\Orca\\managed-v1\\bun-generation'
  function processRow(command: string) {
    return { pid: 100, ppid: 1, name: 'bun-runtime.exe', creationTimeMs: 100, command }
  }
  it.each([
    'C:\\Users\\OWNERN~1\\Orca\\managed-v1\\bun-generation\\bun-runtime.exe',
    'C:\\runtime-junction\\bun-runtime.exe'
  ])('pins an executable reached through %s', async (alias) => {
    const resolve = vi.fn().mockResolvedValue(`${directory}\\bun-runtime.exe`)
    const pinned = await collectPinnedDaemonRuntimeDirectories(
      [processRow(`"${alias}" daemon-entry.js`)],
      [directory],
      resolve
    )
    expect(resolve).toHaveBeenCalledWith(alias)
    expect(pinned).toEqual(new Set([directory]))
  })
  it('vetoes deletion when a known executable cannot be canonicalized', async () => {
    const resolve = vi.fn().mockRejectedValue(new Error('EACCES'))
    expect(
      await collectPinnedDaemonRuntimeDirectories(
        [processRow('"C:\\unknown\\bun-runtime.exe"')],
        [directory],
        resolve
      )
    ).toBeNull()
  })
  it('still pins a gate script when its executable belongs to another generation', async () => {
    const resolve = vi.fn().mockResolvedValue('C:\\other\\bun-runtime.exe')
    const pinned = await collectPinnedDaemonRuntimeDirectories(
      [processRow(`"C:\\other\\bun-runtime.exe" "${directory}\\windows-bun-pty-gate-entry.js"`)],
      [directory],
      resolve
    )
    expect(pinned).toEqual(new Set([directory]))
  })
  it('does not confuse a sibling prefix with an owned directory', async () => {
    const resolve = vi
      .fn()
      .mockImplementation(async (path: string) =>
        path === join(directory, 'bun-runtime.exe')
          ? `${directory}\\bun-runtime.exe`
          : `${directory}.repair-1\\bun-runtime.exe`
      )
    expect(
      await collectPinnedDaemonRuntimeDirectories(
        [processRow('"C:\\other\\bun-runtime.exe"')],
        [directory],
        resolve
      )
    ).toEqual(new Set())
  })
})

it.each(['bun-runtime.exe', 'OpenConsole.exe'])(
  'pins %s when file realpath expands an alias that directory realpath retains',
  async (name) => {
    const directory = 'C:\\Users\\RUNNER~1\\runtime\\bun-generation'
    const executable = `C:\\runtime-junction\\${name}`
    const candidateImage =
      name === 'OpenConsole.exe' ? join(directory, 'conpty', name) : join(directory, name)
    const expanded = `C:\\Users\\runneradmin\\runtime\\bun-generation\\${name}`
    const resolve = vi.fn().mockImplementation(async (path: string) => {
      if (path === executable || path === candidateImage) {
        return expanded
      }
      throw new Error('unexpected path')
    })
    expect(
      await collectPinnedDaemonRuntimeDirectories(
        [{ pid: 100, ppid: 1, name, creationTimeMs: 100, command: `"${executable}"` }],
        [directory],
        resolve
      )
    ).toEqual(new Set([directory]))
    expect(resolve).toHaveBeenCalledWith(candidateImage)
  }
)

it('vetoes deletion when candidate file identity cannot be compared', async () => {
  const executable = 'C:\\other\\bun-runtime.exe'
  const resolve = vi.fn().mockImplementation(async (path: string) => {
    if (path === executable) {
      return executable
    }
    throw new Error('EACCES')
  })
  expect(
    await collectPinnedDaemonRuntimeDirectories(
      [
        {
          pid: 100,
          ppid: 1,
          name: 'bun-runtime.exe',
          creationTimeMs: 100,
          command: `"${executable}"`
        }
      ],
      ['C:\\runtime\\bun-generation'],
      resolve
    )
  ).toBeNull()
})

it('ignores absent staging images but vetoes unknown and published identities', async () => {
  const staging = 'C:\\runtime\\.bun-staging-12345678-1234-1234-1234-123456789abc'
  const executable = 'C:\\unrelated\\bun-runtime.exe'
  const row = {
    pid: 100,
    ppid: 1,
    name: 'bun-runtime.exe',
    creationTimeMs: 100,
    command: `"${executable}"`
  }
  let code = 'ENOENT'
  const resolve = vi.fn().mockImplementation(async (path: string) => {
    if (path === executable) {
      return executable
    }
    throw Object.assign(new Error(code), { code })
  })
  expect(await collectPinnedDaemonRuntimeDirectories([row], [staging], resolve)).toEqual(new Set())
  expect(
    await collectPinnedDaemonRuntimeDirectories(
      [row],
      [`C:\\runtime\\bun-${'a'.repeat(64)}`],
      resolve
    )
  ).toBeNull()
  code = 'EACCES'
  expect(await collectPinnedDaemonRuntimeDirectories([row], [staging], resolve)).toBeNull()
})
