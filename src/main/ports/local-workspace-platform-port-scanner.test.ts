import { describe, expect, it } from 'vitest'
import { parseNetstatListeningOutput } from './local-workspace-platform-port-scanner'

describe('parseNetstatListeningOutput', () => {
  it('finds IPv4 and IPv6 listeners in localized netstat -ano output', () => {
    const output = [
      '',
      'Aktive Verbindungen',
      '',
      '  Proto  Lokale Adresse         Remoteadresse          Status           PID',
      '  TCP    0.0.0.0:135            0.0.0.0:0              ABHÖREN          1100',
      '  TCP    127.0.0.1:45064        0.0.0.0:0              ABHÖREN          2712',
      '  TCP    127.0.0.1:45064        127.0.0.1:50123        HERGESTELLT      2712',
      '  TCP    127.0.0.1:50123        127.0.0.1:45064        HERGESTELLT      3300',
      '  TCP    192.168.1.5:50200      20.42.65.92:443        WARTEND          0',
      '  TCP    [::]:135               [::]:0                 ABHÖREN          1100',
      '  TCP    [::1]:45066            [::]:0                 ABHÖREN          2712',
      '  TCP    [::1]:45066            [::1]:50124            SCHLIESSEN_WARTEN 2712',
      '  UDP    0.0.0.0:5353           *:*                                    4400',
      '  UDP    127.0.0.1:49664        127.0.0.1:49664                        4500',
      '  UDP    [::]:5353              *:*                                    4400',
      ''
    ].join('\r\n')

    expect(parseNetstatListeningOutput(output)).toEqual([
      { host: '0.0.0.0', port: 135, pid: 1100 },
      { host: '127.0.0.1', port: 45064, pid: 2712 },
      { host: '::1', port: 45066, pid: 2712 }
    ])
  })

  it('keeps one row when the same process listens on both IPv4 and IPv6', () => {
    const output = [
      '  TCP    0.0.0.0:3000           0.0.0.0:0              LISTENING       500',
      '  TCP    127.0.0.1:5000         0.0.0.0:0              LISTENING       600',
      '  TCP    127.0.0.1:7000         0.0.0.0:0              LISTENING       700',
      '  TCP    [::]:3000              [::]:0                 LISTENING       500',
      '  TCP    [::1]:5000             [::]:0                 LISTENING       600',
      '  TCP    [::1]:7000             [::]:0                 LISTENING       701'
    ].join('\r\n')

    expect(parseNetstatListeningOutput(output)).toEqual([
      { host: '0.0.0.0', port: 3000, pid: 500 },
      { host: '127.0.0.1', port: 5000, pid: 600 },
      { host: '127.0.0.1', port: 7000, pid: 700 },
      { host: '::1', port: 7000, pid: 701 }
    ])
  })
})
