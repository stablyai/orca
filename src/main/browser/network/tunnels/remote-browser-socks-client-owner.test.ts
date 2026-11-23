import { readFile } from 'node:fs/promises'
import { createServer, connect, type Server, type Socket } from 'node:net'
import { createInterface } from 'node:readline'
import { spawnProcess } from '@orca/process-host'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  loadWindowsSecurityAsync,
  resetWindowsSecurityLoadForTests,
  setWindowsSecurityForTests
} from '../../../../shared/secure-storage/windows-security-addon'
import {
  createFakeWindowsSecurity,
  FAKE_USER_SID
} from '../../../../shared/secure-storage/windows-security-addon.test-fixture'
import {
  findProcNetTcpClientUid,
  verifySocksClientOwner
} from './remote-browser-socks-client-owner'

// Rows follow the kernel's tcp4_seq_show / get_timewait4_sock formats. Orca is uid 1000 with its
// SOCKS listener on 127.0.0.1:40000 (9C40); its browser connects from 127.0.0.1:54321 (D431).
// Uid 1001 reuses port 54321 from 127.0.0.2, so only the full address pair tells the two apart.
const PROC_NET_TCP = `  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 0100007F:9C40 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 50001 1 0000000000000000 100 0 0 10 0
   1: 0100007F:D431 0100007F:9C40 01 00000000:00000000 00:00000000 00000000  1000        0 50010 1 0000000000000000 20 4 30 10 -1
   2: 0100007F:9C40 0100007F:D431 01 00000000:00000000 00:00000000 00000000  1000        0 50011 1 0000000000000000 20 4 30 10 -1
   3: 0200007F:D431 0100007F:9C40 01 00000000:00000000 00:00000000 00000000  1001        0 50020 1 0000000000000000 20 4 30 10 -1
   4: 0100007F:9C40 0200007F:D431 01 00000000:00000000 00:00000000 00000000  1000        0 50021 1 0000000000000000 20 4 30 10 -1
   5: 0100007F:C350 0100007F:9C40 06 00000000:00000000 03:00001520 00000000     0        0 0 3 0000000000000000
`
// A dual-stack socket of uid 1002 connected from ::ffff:127.0.0.1:51000 (C738).
const PROC_NET_TCP6 = `  sl  local_address                         remote_address                        st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 0000000000000000FFFF00000100007F:C738 0000000000000000FFFF00000100007F:9C40 01 00000000:00000000 00:00000000 00000000  1002        0 50030 1 0000000000000000 20 4 30 10 -1
`

const LISTENER = { host: '127.0.0.1', port: 40000 }

describe('findProcNetTcpClientUid', () => {
  it('returns the owner of the connecting end, matched on both addresses and ports', () => {
    expect(
      findProcNetTcpClientUid(PROC_NET_TCP, { host: '127.0.0.1', port: 54321 }, LISTENER)
    ).toBe(1000)
    expect(
      findProcNetTcpClientUid(PROC_NET_TCP, { host: '127.0.0.2', port: 54321 }, LISTENER)
    ).toBe(1001)
    expect(
      findProcNetTcpClientUid(PROC_NET_TCP6, { host: '127.0.0.1', port: 51000 }, LISTENER)
    ).toBe(1002)
    // A TIME_WAIT row has no owner left to vouch for.
    expect(
      findProcNetTcpClientUid(PROC_NET_TCP, { host: '127.0.0.1', port: 50000 }, LISTENER)
    ).toBeNull()
  })
})

// process.getuid does not exist on Windows, so it cannot be stubbed there.
describe.skipIf(process.platform === 'win32')('verifySocksClientOwner on Linux', () => {
  const realPlatform = process.platform
  const tables: Record<string, string> = {
    '/proc/net/tcp': PROC_NET_TCP,
    '/proc/net/tcp6': PROC_NET_TCP6
  }
  const readTable = async (path: string): Promise<string> => tables[path] ?? ''
  const accepted = (remoteAddress: string, remotePort: number) => ({
    localAddress: '127.0.0.1',
    localPort: 40000,
    remoteAddress,
    remotePort
  })

  beforeEach(() => {
    Object.defineProperty(process, 'platform', { value: 'linux' })
    vi.spyOn(process, 'getuid').mockReturnValue(1000)
  })
  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: realPlatform })
    vi.restoreAllMocks()
  })

  it("admits only this user's sockets and fails closed when the owner is unknown", async () => {
    await expect(verifySocksClientOwner(accepted('127.0.0.1', 54321), readTable)).resolves.toEqual({
      allowed: true
    })
    await expect(verifySocksClientOwner(accepted('127.0.0.2', 54321), readTable)).resolves.toEqual({
      allowed: false,
      reason: 'foreign-owner',
      owner: 'uid 1001'
    })
    await expect(
      verifySocksClientOwner(accepted('::ffff:127.0.0.1', 51000), readTable)
    ).resolves.toEqual({ allowed: false, reason: 'foreign-owner', owner: 'uid 1002' })
    await expect(
      verifySocksClientOwner(accepted('127.0.0.1', 50000), readTable)
    ).resolves.toMatchObject({ allowed: false, reason: 'lookup-failed' })
    await expect(
      verifySocksClientOwner(accepted('127.0.0.1', 54321), async () => {
        throw new Error('EACCES')
      })
    ).resolves.toMatchObject({ allowed: false, reason: 'lookup-failed', detail: 'EACCES' })
  })
})

describe('verifySocksClientOwner on Windows', () => {
  const realPlatform = process.platform
  const socket = {
    localAddress: '127.0.0.1',
    localPort: 40000,
    remoteAddress: '127.0.0.1',
    remotePort: 54321
  }
  const withOwner = (lookup: () => Promise<{ pid: number; sid: string } | null>) => {
    const fake = createFakeWindowsSecurity()
    fake.tcpClientOwnerAsync = lookup
    setWindowsSecurityForTests(fake)
  }

  beforeEach(() => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
  })
  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: realPlatform })
    resetWindowsSecurityLoadForTests()
  })

  it('admits only this SID, refuses when a lookup that ran finds no owner, and admits unchecked only without the lookup', async () => {
    withOwner(async () => ({ pid: 7, sid: FAKE_USER_SID }))
    await expect(verifySocksClientOwner(socket)).resolves.toEqual({ allowed: true })
    withOwner(async () => ({ pid: 8, sid: 'S-1-5-21-1-2-3-1002' }))
    await expect(verifySocksClientOwner(socket)).resolves.toEqual({
      allowed: false,
      reason: 'foreign-owner',
      owner: 'S-1-5-21-1-2-3-1002'
    })
    withOwner(async () => null)
    await expect(verifySocksClientOwner(socket)).resolves.toMatchObject({
      allowed: false,
      reason: 'lookup-failed'
    })
    withOwner(async () => {
      throw new Error('OpenProcess failed with Win32 error 5')
    })
    await expect(verifySocksClientOwner(socket)).resolves.toEqual({
      allowed: false,
      reason: 'lookup-failed',
      detail: 'OpenProcess failed with Win32 error 5'
    })

    const stale = createFakeWindowsSecurity()
    stale.hasNativeExport = (name) => name !== 'tcpClientOwnerAsync'
    setWindowsSecurityForTests(stale)
    await expect(verifySocksClientOwner(socket)).resolves.toMatchObject({
      allowed: true,
      unchecked: expect.any(String)
    })
    setWindowsSecurityForTests(null)
    await expect(verifySocksClientOwner(socket)).resolves.toMatchObject({
      allowed: true,
      unchecked: expect.any(String)
    })
  })
})

// Runs in the Windows boundary CI job, which builds the real addon.
describe.skipIf(process.platform !== 'win32')(
  'verifySocksClientOwner against the real Windows TCP table',
  () => {
    let server: Server | null = null
    const cleanups: (() => void)[] = []
    afterEach(() => {
      cleanups.splice(0).forEach((cleanup) => cleanup())
      server?.close()
      resetWindowsSecurityLoadForTests()
    })

    const listen = async (): Promise<{ port: number; accepted: Promise<Socket> }> => {
      const accepted = new Promise<Socket>((resolve) => {
        server = createServer(resolve)
      })
      await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
      const address = server!.address()
      if (!address || typeof address === 'string') {
        throw new Error('no TCP address')
      }
      return { port: address.port, accepted }
    }

    it("admits this process's own client", async () => {
      const { port, accepted } = await listen()
      const client = connect(port, '127.0.0.1')
      cleanups.push(() => client.destroy())
      const socket = await accepted
      cleanups.push(() => socket.destroy())
      // toEqual: a stale addon would answer { allowed: true, unchecked }.
      await expect(verifySocksClientOwner(socket)).resolves.toEqual({ allowed: true })
    })

    it("reads the connecting side's row, not the listener's accepted copy", async () => {
      const security = await loadWindowsSecurityAsync()
      if ('error' in security) {
        throw new Error(`the windows-security addon did not load: ${security.error}`)
      }
      const { port, accepted } = await listen()
      const child = spawnProcess({
        program: process.execPath,
        args: [
          '-e',
          "const s = require('node:net').connect(Number(process.env.PORT), '127.0.0.1', () => console.log('connected')); process.stdin.on('end', () => s.destroy()); process.stdin.resume()"
        ],
        env: { ...process.env, PORT: String(port) },
        stdio: 'pipe'
      })
      cleanups.push(() => child.stdin.end())
      const socket = await accepted
      cleanups.push(() => socket.destroy())
      await createInterface({ input: child.stdout })[Symbol.asyncIterator]().next()

      const clientPort = socket.remotePort!
      await expect(
        security.addon.tcpClientOwnerAsync('127.0.0.1', clientPort, '127.0.0.1', port)
      ).resolves.toEqual({ pid: child.pid, sid: security.userSid })
      await expect(
        security.addon.tcpClientOwnerAsync('127.0.0.1', port, '127.0.0.1', clientPort)
      ).resolves.toEqual({ pid: process.pid, sid: security.userSid })
      await expect(
        security.addon.tcpClientOwnerAsync('127.0.0.2', clientPort, '127.0.0.1', port)
      ).resolves.toBeNull()
    })
  }
)

describe.skipIf(process.platform !== 'linux')(
  'verifySocksClientOwner against the real kernel',
  () => {
    let server: Server | null = null
    let client: Socket | null = null
    afterEach(() => {
      client?.destroy()
      server?.close()
    })

    it("finds this process's own loopback client in /proc/net/tcp", async () => {
      const accepted = new Promise<Socket>((resolve) => {
        server = createServer(resolve)
      })
      await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
      const address = server!.address()
      if (!address || typeof address === 'string') {
        throw new Error('no TCP address')
      }
      client = connect(address.port, '127.0.0.1')
      const socket = await accepted
      expect(
        findProcNetTcpClientUid(
          await readFile('/proc/net/tcp', 'utf-8'),
          { host: socket.remoteAddress!, port: socket.remotePort! },
          { host: '127.0.0.1', port: address.port }
        )
      ).toBe(process.getuid!())
      await expect(verifySocksClientOwner(socket)).resolves.toEqual({ allowed: true })
      socket.destroy()
    })
  }
)
