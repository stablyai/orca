import { afterEach, expect, it, vi } from 'vitest'
import type * as Fs from 'node:fs'
import type * as FsPromises from 'node:fs/promises'

// What the host's filesystem holds: paths to file contents, and the bus socket.
const disk = vi.hoisted(() => ({ files: new Map<string, string>(), busSocket: false }))
const busPath = `/run/user/${process.getuid?.()}/bus`
const missing = () => Object.assign(new Error('ENOENT'), { code: 'ENOENT' })

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof Fs>()
  return {
    ...actual,
    existsSync: (path: string) => disk.files.has(path),
    readFileSync: (path: string) => {
      const text = disk.files.get(path)
      if (text === undefined) {
        throw missing()
      }
      return text
    },
    statSync: (path: string) => {
      if (path !== busPath || !disk.busSocket) {
        throw missing()
      }
      return { isSocket: () => true }
    }
  }
})
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>()
  return {
    ...actual,
    readFile: async (path: string) => {
      const text = disk.files.get(path)
      if (text === undefined) {
        throw missing()
      }
      return text
    },
    stat: async (path: string) => {
      if (path === busPath ? !disk.busSocket : !disk.files.has(path)) {
        throw missing()
      }
      return { isSocket: () => path === busPath }
    }
  }
})

const {
  antigravityUsesFileStoreAsync,
  isAntigravityContainerOrWslHost,
  isAntigravityFileStorageHost
} = await import('./native-file-credentials')

afterEach(() => {
  vi.restoreAllMocks()
  disk.files.clear()
  disk.busSocket = false
})

it.each<[string, NodeJS.Platform, NodeJS.ProcessEnv, Record<string, string>, boolean, boolean]>([
  ['an SSH session', 'linux', { SSH_CONNECTION: '1' }, {}, true, true],
  [
    'a desktop session bus',
    'linux',
    { DBUS_SESSION_BUS_ADDRESS: 'unix:path=/x' },
    {},
    false,
    false
  ],
  ['a bus socket without an address', 'linux', {}, {}, true, false],
  ['no session bus at all', 'linux', {}, {}, false, true],
  [
    'Docker',
    'linux',
    { DBUS_SESSION_BUS_ADDRESS: 'unix:path=/x' },
    { '/.dockerenv': '' },
    false,
    true
  ],
  [
    'a containerd cgroup',
    'linux',
    { DBUS_SESSION_BUS_ADDRESS: 'unix:path=/x' },
    { '/proc/1/cgroup': '0::/containerd/abc' },
    false,
    true
  ],
  [
    'a WSL kernel',
    'linux',
    { DBUS_SESSION_BUS_ADDRESS: 'unix:path=/x' },
    { '/proc/sys/kernel/osrelease': '5.15.0-microsoft-standard-WSL2' },
    false,
    true
  ],
  ['macOS', 'darwin', {}, {}, false, false]
])(
  'reads %s as the credential backends do',
  async (_case, platform, env, files, busSocket, fileStore) => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue(platform)
    Object.entries(files).forEach(([path, text]) => disk.files.set(path, text))
    disk.busSocket = busSocket

    const backends =
      isAntigravityFileStorageHost(env) ||
      (platform === 'linux' && isAntigravityContainerOrWslHost())
    expect(backends).toBe(fileStore)
    expect(await antigravityUsesFileStoreAsync(env)).toBe(fileStore)
  }
)
