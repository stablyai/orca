import { readFileSync } from 'node:fs'

export type SandboxTcpCounters = {
  inSegs: number
  outSegs: number
  retransSegs: number
  inErrs: number
  outRsts: number
  estabResets: number
}

// The two `Tcp:` lines of /proc/net/snmp: field names, then values.
export function parseProcNetSnmpTcp(text: string): SandboxTcpCounters | undefined {
  const [names, values] = text
    .split('\n')
    .filter((line) => line.startsWith('Tcp:'))
    .map((line) => line.trim().split(/\s+/).slice(1))
  if (!names || !values || names.length !== values.length) {
    return undefined
  }
  const field = (name: string): number => {
    const value = Number(values[names.indexOf(name)])
    return Number.isSafeInteger(value) && value >= 0 ? value : Number.NaN
  }
  const counters = {
    inSegs: field('InSegs'),
    outSegs: field('OutSegs'),
    retransSegs: field('RetransSegs'),
    inErrs: field('InErrs'),
    outRsts: field('OutRsts'),
    estabResets: field('EstabResets')
  }
  return Object.values(counters).every(Number.isFinite) ? counters : undefined
}

// Cloud Run runs every container of an instance on one network stack (checked on gen1, 10-26), so
// this counts the Cloud SQL proxy sidecar's flows to Postgres as well as the relay's own.
export function readSandboxTcpCounters(
  read: () => string = () => readFileSync('/proc/net/snmp', 'utf8')
): SandboxTcpCounters | undefined {
  try {
    return parseProcNetSnmpTcp(read())
  } catch {
    return undefined
  }
}

export function sandboxTcpCounterDeltas(
  previous: SandboxTcpCounters,
  current: SandboxTcpCounters
): Record<string, number> | undefined {
  const deltas = {
    tcpInSegsDelta: current.inSegs - previous.inSegs,
    tcpOutSegsDelta: current.outSegs - previous.outSegs,
    tcpRetransSegsDelta: current.retransSegs - previous.retransSegs,
    tcpInErrsDelta: current.inErrs - previous.inErrs,
    tcpOutRstsDelta: current.outRsts - previous.outRsts,
    tcpEstabResetsDelta: current.estabResets - previous.estabResets
  }
  // A counter that went backwards was reset; that window has no honest delta.
  return Object.values(deltas).every((delta) => delta >= 0) ? deltas : undefined
}
