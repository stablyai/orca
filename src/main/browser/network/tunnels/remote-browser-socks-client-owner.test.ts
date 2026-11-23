import { readFile } from 'node:fs/promises'
import { createServer, connect, type Server, type Socket } from 'node:net'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
      uid: 1001
    })
    await expect(
      verifySocksClientOwner(accepted('::ffff:127.0.0.1', 51000), readTable)
    ).resolves.toEqual({ allowed: false, reason: 'foreign-owner', uid: 1002 })
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
