import type * as FsPromises from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { scanPlatformListeningPorts } from './local-workspace-platform-port-scanner'

// Guards the Linux port scan walking every process's fds on each pass (#45700).
const PROC_NET_HEADER =
  '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n'
const procNetRow = (portHex: string, uid: number, inode: number): string =>
  `   0: 0100007F:${portHex} 00000000:0000 0A 00000000:00000000 00:00000000 00000000 ${uid} 0 ${inode} 1 0000000000000000 100 0 0 10 0\n`

type FakeProcess = { uid: number; comm: string; cmdline: string; cwd: string; fds: string[] }
const OWN_UID = vi.hoisted(() => 1000)
const fakeProc = vi.hoisted(() => {
  const state: { tcp: string; processes: Map<number, FakeProcess>; readdirPaths: string[] } = {
    tcp: '',
    processes: new Map(),
    readdirPaths: []
  }
  return state
})

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>()
  const missing = (): Promise<never> =>
    Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))
  const processAt = (path: string): [FakeProcess | undefined, string[]] => {
    const [, , pidText, ...rest] = path.split('/')
    return [fakeProc.processes.get(Number(pidText)), rest]
  }
  return {
    ...actual,
    readFile: (path: string) => {
      if (path === '/proc/net/tcp') {
        return Promise.resolve(fakeProc.tcp)
      }
      if (path === '/proc/net/tcp6') {
        return Promise.resolve('')
      }
      const [proc, rest] = processAt(path)
      return proc && rest[0] === 'comm'
        ? Promise.resolve(`${proc.comm}\n`)
        : proc && rest[0] === 'cmdline'
          ? Promise.resolve(proc.cmdline)
          : missing()
    },
    readdir: (path: string) => {
      fakeProc.readdirPaths.push(path)
      if (path === '/proc') {
        return Promise.resolve(['self', ...[...fakeProc.processes.keys()].map(String)])
      }
      const [proc, rest] = processAt(path)
      // The kernel denies another uid's fd table to a non-root reader.
      return proc && rest[0] === 'fd' && proc.uid === OWN_UID
        ? Promise.resolve(proc.fds.map((_, i) => String(i)))
        : missing()
    },
    readlink: (path: string) => {
      const [proc, rest] = processAt(path)
      if (proc && rest[0] === 'cwd') {
        return Promise.resolve(proc.cwd)
      }
      const link =
        proc && rest[0] === 'fd' && proc.uid === OWN_UID ? proc.fds[Number(rest[1])] : undefined
      return link === undefined ? missing() : Promise.resolve(link)
    },
    stat: (path: string) => {
      const [proc] = processAt(path)
      return proc ? Promise.resolve({ uid: proc.uid }) : missing()
    }
  }
})

describe('Linux listener owner lookup', () => {
  beforeEach(() => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
    vi.spyOn(process, 'getuid').mockReturnValue(OWN_UID)
    fakeProc.processes = new Map([
      [
        100,
        {
          uid: OWN_UID,
          comm: 'node',
          cmdline: 'node\u0000server.js',
          cwd: '/repo',
          fds: ['/dev/null', 'socket:[5001]']
        }
      ],
      [200, { uid: OWN_UID, comm: 'zsh', cmdline: 'zsh', cwd: '/home', fds: ['/dev/pts/1'] }],
      [300, { uid: 0, comm: 'sshd', cmdline: 'sshd', cwd: '/', fds: ['socket:[6001]'] }]
    ])
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('reads only the cached owner fds when no listener is new, and walks again for a new one', async () => {
    fakeProc.tcp = PROC_NET_HEADER + procNetRow('1F90', OWN_UID, 5001) + procNetRow('0016', 0, 6001)
    const expectedPort = {
      host: '127.0.0.1',
      port: 8080,
      pid: 100,
      socketId: '5001',
      processName: 'node',
      commandLine: 'node server.js',
      cwd: '/repo'
    }
    const sshPort = { host: '127.0.0.1', port: 22, pid: undefined, socketId: '6001' }

    fakeProc.readdirPaths = []
    const first = await scanPlatformListeningPorts({})
    expect(first.ports).toEqual([expectedPort, sshPort])
    expect(fakeProc.readdirPaths).toEqual(['/proc', '/proc/100/fd', '/proc/200/fd'])

    fakeProc.readdirPaths = []
    const second = await scanPlatformListeningPorts({})
    expect(second.ports).toEqual([expectedPort, sshPort])
    expect(fakeProc.readdirPaths).toEqual(['/proc/100/fd'])

    fakeProc.processes.get(200)!.fds.push('socket:[5002]')
    fakeProc.tcp += procNetRow('1F91', OWN_UID, 5002)
    fakeProc.readdirPaths = []
    const third = await scanPlatformListeningPorts({})
    expect(third.ports.map((port) => [port.port, port.pid])).toEqual([
      [8080, 100],
      [22, undefined],
      [8081, 200]
    ])
    expect(fakeProc.readdirPaths).toEqual(['/proc/100/fd', '/proc', '/proc/100/fd', '/proc/200/fd'])
  })
})
