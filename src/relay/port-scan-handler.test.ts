import { describe, expect, it, vi } from 'vitest'
import {
  ownershipFieldsForSocket,
  parseHexAddress,
  parsePasswdUidUsernames,
  parseProcNetListeningSockets,
  resolveUsernameForUid
} from './port-scan-handler'
import { parseWindowsNetstatOutput, parseWindowsPowerShellPortRows } from './windows-port-scan'

describe('parseHexAddress', () => {
  it('parses IPv4 localhost (127.0.0.1)', () => {
    // 127.0.0.1 in little-endian hex: 0100007F
    const result = parseHexAddress('0100007F:0BB8')
    expect(result).toEqual({ host: '127.0.0.1', port: 3000 })
  })

  it('parses IPv4 all-interfaces (0.0.0.0)', () => {
    const result = parseHexAddress('00000000:1F90')
    expect(result).toEqual({ host: '0.0.0.0', port: 8080 })
  })

  it('parses port 22 correctly', () => {
    const result = parseHexAddress('00000000:0016')
    expect(result).toEqual({ host: '0.0.0.0', port: 22 })
  })

  it('parses port 443 correctly', () => {
    const result = parseHexAddress('0100007F:01BB')
    expect(result).toEqual({ host: '127.0.0.1', port: 443 })
  })

  it('parses a non-localhost IPv4 address', () => {
    // 192.168.1.100 in little-endian: 6401A8C0
    const result = parseHexAddress('6401A8C0:1388')
    expect(result).toEqual({ host: '192.168.1.100', port: 5000 })
  })

  it('parses IPv6 all-zeros (::)', () => {
    const result = parseHexAddress('00000000000000000000000000000000:1F90')
    expect(result).toEqual({ host: '::', port: 8080 })
  })

  it('parses IPv6 loopback (::1)', () => {
    const result = parseHexAddress('00000000000000000000000001000000:0BB8')
    expect(result).toEqual({ host: '::1', port: 3000 })
  })

  it('returns null for port 0', () => {
    const result = parseHexAddress('0100007F:0000')
    expect(result).toBeNull()
  })

  it('returns null for malformed input', () => {
    expect(parseHexAddress('invalid')).toBeNull()
    expect(parseHexAddress('')).toBeNull()
    expect(parseHexAddress('::::')).toBeNull()
  })

  it('parses high ports correctly', () => {
    // Port 65535 = FFFF
    const result = parseHexAddress('0100007F:FFFF')
    expect(result).toEqual({ host: '127.0.0.1', port: 65535 })
  })

  it('parses port 5432 (postgres)', () => {
    const result = parseHexAddress('0100007F:1538')
    expect(result).toEqual({ host: '127.0.0.1', port: 5432 })
  })

  it('parses port 3306 (mysql)', () => {
    const result = parseHexAddress('00000000:0CEA')
    expect(result).toEqual({ host: '0.0.0.0', port: 3306 })
  })
})

describe('parseProcNetListeningSockets', () => {
  it('parses listen rows with owner uid', () => {
    const content = [
      '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode',
      '   0: 0100007F:0BB8 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 12345 1 0000000000000000 100 0 0 10 0',
      '   1: 00000000:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1001        0 12346 1 0000000000000000 100 0 0 10 0',
      // ESTABLISHED — ignored
      '   2: 0100007F:0BB9 0100007F:ABCD 01 00000000:00000000 00:00000000 00000000  1000        0 12347 1 0000000000000000 100 0 0 10 0'
    ].join('\n')

    expect(parseProcNetListeningSockets(content)).toEqual([
      { host: '127.0.0.1', port: 3000, inode: 12345, uid: 1000 },
      { host: '0.0.0.0', port: 8080, inode: 12346, uid: 1001 }
    ])
  })

  it('keeps listen rows with invalid uid but drops invalid inode', () => {
    const content = [
      '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode',
      '   0: 0100007F:0BB8 00000000:0000 0A 00000000:00000000 00:00000000 00000000  notuid     0 12345 1',
      '   1: 0100007F:0BB9 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 0 1'
    ].join('\n')

    expect(parseProcNetListeningSockets(content)).toEqual([
      { host: '127.0.0.1', port: 3000, inode: 12345, uid: undefined }
    ])
  })
})

describe('parsePasswdUidUsernames / ownershipFieldsForSocket', () => {
  it('resolves usernames from passwd content', () => {
    const map = parsePasswdUidUsernames(
      ['root:x:0:0:root:/root:/bin/bash', 'alice:x:1000:1000:Alice:/home/alice:/bin/bash', ''].join(
        '\n'
      )
    )
    expect(map.get(0)).toBe('root')
    expect(map.get(1000)).toBe('alice')
    expect(resolveUsernameForUid(1000, map)).toBe('alice')
    expect(resolveUsernameForUid(42, map)).toBe('42')
  })

  it('marks ownership against the connecting uid and falls back to numeric username', () => {
    const empty = new Map<number, string>()
    expect(ownershipFieldsForSocket(1000, 1000, empty)).toEqual({
      uid: 1000,
      username: '1000',
      ownedByConnectingUser: true
    })
    expect(ownershipFieldsForSocket(1001, 1000, empty)).toEqual({
      uid: 1001,
      username: '1001',
      ownedByConnectingUser: false
    })
    // Why: no getuid (e.g. constrained environments) → leave ownership flag unset.
    expect(ownershipFieldsForSocket(1000, undefined, empty)).toEqual({
      uid: 1000,
      username: '1000'
    })
    // Why: unparseable /proc uid → surface the port without ownership metadata.
    expect(ownershipFieldsForSocket(undefined, 1000, empty)).toEqual({})
  })
})

describe('parseWindowsPowerShellPortRows', () => {
  it('parses PowerShell JSON arrays', () => {
    expect(
      parseWindowsPowerShellPortRows(
        JSON.stringify([
          { host: '127.0.0.1', port: 5173, pid: 1234, processName: 'node' },
          { host: '0.0.0.0', port: 8080, pid: 5678, processName: 'dotnet' }
        ])
      )
    ).toEqual([
      { host: '127.0.0.1', port: 5173, pid: 1234, processName: 'node' },
      { host: '0.0.0.0', port: 8080, pid: 5678, processName: 'dotnet' }
    ])
  })

  it('parses single-object PowerShell JSON', () => {
    expect(
      parseWindowsPowerShellPortRows(
        JSON.stringify({ host: '::1', port: '3000', pid: '4321', processName: 'node' })
      )
    ).toEqual([{ host: '::1', port: 3000, pid: 4321, processName: 'node' }])
  })

  it('ignores malformed rows', () => {
    expect(
      parseWindowsPowerShellPortRows(
        JSON.stringify([
          { host: '127.0.0.1', port: 5173, pid: 1234 },
          { host: '127.0.0.1', port: 'nan', pid: 1234 },
          { port: 8080, pid: 5678 }
        ])
      )
    ).toEqual([{ host: '127.0.0.1', port: 5173, pid: 1234 }])
  })
})

describe('parseWindowsNetstatOutput', () => {
  it('parses Windows netstat listening rows', () => {
    const output = [
      '  Proto  Local Address          Foreign Address        State           PID',
      '  TCP    0.0.0.0:5173           0.0.0.0:0              LISTENING       1234',
      '  TCP    127.0.0.1:9229         0.0.0.0:0              ESTABLISHED     1234',
      '  TCP    [::1]:3000             [::]:0                 LISTENING       5678'
    ].join('\r\n')

    expect(parseWindowsNetstatOutput(output)).toEqual([
      { host: '0.0.0.0', port: 5173, pid: 1234 },
      { host: '::1', port: 3000, pid: 5678 }
    ])
  })

  it('parses Windows netstat rows without whitespace regex splitting', () => {
    const splitSpy = vi.spyOn(String.prototype, 'split')

    expect(
      parseWindowsNetstatOutput(
        '  TCP    127.0.0.1:3000         0.0.0.0:0              LISTENING       4242'
      )
    ).toEqual([{ host: '127.0.0.1', port: 3000, pid: 4242 }])

    const usedWhitespaceFieldSplit = splitSpy.mock.calls.some(
      ([separator]) => separator instanceof RegExp && separator.source.includes('\\s+')
    )
    splitSpy.mockRestore()
    expect(usedWhitespaceFieldSplit).toBe(false)
  })
})
