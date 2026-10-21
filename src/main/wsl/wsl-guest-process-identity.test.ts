import { describe, expect, it } from 'vitest'
import {
  parseWslGuestIdentity,
  procStatStartTicks,
  wslGuestIdentityCommand
} from './wsl-guest-process-identity'

const BOOT_ID = '6a0c4b1e-2f3d-4e5f-8a9b-0c1d2e3f4a5b'
// Fields 3..22 after the name; field 22 (start ticks) is the last one here.
const statTail = (ticks: number): string =>
  `S 0 1 1 0 -1 4194560 100 0 0 0 1 2 0 0 20 0 1 0 ${ticks} 2000000 300`
const SEP = '--orca-identity--'

describe('procStatStartTicks', () => {
  it('reads field 22 even when the process name holds spaces and parentheses', () => {
    expect(procStatStartTicks(`1 (init) ${statTail(7)}`)).toBe('7')
    expect(procStatStartTicks(`42 (node (orcad) x) ${statTail(98765)}`)).toBe('98765')
  })

  it('rejects malformed lines', () => {
    expect(procStatStartTicks('garbage')).toBeNull()
    expect(procStatStartTicks('1 (init) S 0')).toBeNull()
  })
})

describe('parseWslGuestIdentity', () => {
  it('keys the distro by boot id and pid 1 start ticks, and orcad by pid and start ticks', () => {
    const output = [
      `${BOOT_ID}\n`,
      `\n1 (init) ${statTail(12)}\n`,
      `\n4321 (node) ${statTail(5000)}\n`,
      '\n'
    ].join(SEP)
    expect(parseWslGuestIdentity(output)).toEqual({
      distroInstance: `${BOOT_ID}:12`,
      orcad: '4321:5000'
    })
  })

  it('reports orcad as gone when its stat is missing', () => {
    const output = [`${BOOT_ID}\n`, `\n1 (init) ${statTail(12)}\n`, '\n', '\n'].join(SEP)
    expect(parseWslGuestIdentity(output)?.orcad).toBeNull()
  })

  it('returns null (unverifiable) for output it cannot trust', () => {
    expect(parseWslGuestIdentity('')).toBeNull()
    expect(parseWslGuestIdentity(['not-a-boot-id', '1 (init) x', '', ''].join(SEP))).toBeNull()
  })
})

describe('wslGuestIdentityCommand', () => {
  it('only interpolates a validated pid', () => {
    expect(wslGuestIdentityCommand(4321)).toContain('/proc/4321/stat')
    expect(wslGuestIdentityCommand(null)).not.toContain('/proc/null')
    expect(wslGuestIdentityCommand(-1)).not.toContain('/proc/-1')
    // Nothing time-of-day based: identity must survive a guest clock jump.
    expect(wslGuestIdentityCommand(4321)).not.toMatch(/date|uptime|btime/)
  })
})
