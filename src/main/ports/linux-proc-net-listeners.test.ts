import { describe, expect, it } from 'vitest'
import { parseProcNetTcp } from './linux-proc-net-listeners'

// We are uid 1000; 1001 and directory user 1234567 are coworkers; 113 and 61200 (DynamicUser) are services.
const PROC_NET_TCP = `  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 0100007F:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 41234 1 0000000000000000 100 0 0 10 0
   1: 00000000:1F91 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1001        0 41235 1 0000000000000000 100 0 0 10 0
   2: 00000000:0016 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 20101 1 0000000000000000 100 0 0 10 0
   3: 0100007F:1538 00000000:0000 0A 00000000:00000000 00:00000000 00000000   113        0 20777 1 0000000000000000 100 0 0 10 0
   4: 0100007F:2B67 00000000:0000 0A 00000000:00000000 00:00000000 00000000 65534        0 20888 1 0000000000000000 100 0 0 10 0
   6: 00000000:0BB8 00000000:0000 0A 00000000:00000000 00:00000000 00000000 1234567      0 41300 1 0000000000000000 100 0 0 10 0
   7: 0100007F:1F49 00000000:0000 0A 00000000:00000000 00:00000000 00000000 61200        0 20999 1 0000000000000000 100 0 0 10 0
   5: 0100007F:1F90 0100007F:D2A4 01 00000000:00000000 00:00000000 00000000  1000        0 41299 1 0000000000000000 20 4 30 10 -1
`

describe('parseProcNetTcp', () => {
  it("drops other login users' listeners but keeps ours, root's and system services'", () => {
    expect(parseProcNetTcp(PROC_NET_TCP, 1000)).toEqual([
      { host: '127.0.0.1', port: 8080, inode: 41234 },
      { host: '0.0.0.0', port: 22, inode: 20101 },
      { host: '127.0.0.1', port: 5432, inode: 20777 },
      { host: '127.0.0.1', port: 11111, inode: 20888 },
      { host: '127.0.0.1', port: 8009, inode: 20999 }
    ])
  })

  it('keeps every listener when the scanning host runs as root', () => {
    expect(parseProcNetTcp(PROC_NET_TCP, 0).map((listener) => listener.port)).toEqual([
      8080, 8081, 22, 5432, 11111, 3000, 8009
    ])
  })
})
