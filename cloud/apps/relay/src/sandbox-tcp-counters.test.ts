import { describe, expect, it } from 'vitest'
import {
  parseProcNetSnmpTcp,
  readSandboxTcpCounters,
  sandboxTcpCounterDeltas
} from './sandbox-tcp-counters.js'

// Tcp lines in /proc/net/snmp's layout, with counter values a Cloud Run gen1 (gVisor) sandbox reported on 2026-10-26.
const GEN1_SNMP = [
  'Ip: Forwarding DefaultTTL InReceives',
  'Ip: 1 64 2000',
  'Tcp: RtoAlgorithm RtoMin RtoMax MaxConn ActiveOpens PassiveOpens AttemptFails EstabResets CurrEstab InSegs OutSegs RetransSegs InErrs OutRsts InCsumErrors',
  'Tcp: 1 200 120000 -1 5 3 0 0 2 485 212 1 0 122 0',
  'Udp: InDatagrams NoPorts',
  'Udp: 4 0'
].join('\n')

const counters = (retransSegs: number, inSegs = 485) => ({
  inSegs,
  outSegs: 212,
  retransSegs,
  inErrs: 0,
  outRsts: 122,
  estabResets: 0
})

describe('sandbox TCP counters', () => {
  it('reads the Tcp counters of /proc/net/snmp', () => {
    expect(parseProcNetSnmpTcp(GEN1_SNMP)).toEqual(counters(1))
  })

  it('reads nothing from a file without both Tcp lines or with a non-numeric counter', () => {
    expect(parseProcNetSnmpTcp('Ip: Forwarding\nIp: 1')).toBeUndefined()
    expect(parseProcNetSnmpTcp(GEN1_SNMP.replace(' 485 ', ' x '))).toBeUndefined()
  })

  it('reads nothing where the file is absent, as off Linux', () => {
    expect(
      readSandboxTcpCounters(() => {
        throw new Error('ENOENT')
      })
    ).toBeUndefined()
  })

  it('reports per-window deltas, and none across a counter reset', () => {
    expect(sandboxTcpCounterDeltas(counters(1), counters(4, 900))).toEqual({
      tcpInSegsDelta: 415,
      tcpOutSegsDelta: 0,
      tcpRetransSegsDelta: 3,
      tcpInErrsDelta: 0,
      tcpOutRstsDelta: 0,
      tcpEstabResetsDelta: 0
    })
    expect(sandboxTcpCounterDeltas(counters(4), counters(1))).toBeUndefined()
  })
})
