import { describe, expect, it } from 'vitest'
import { e2eeKeyHostBinding, type E2EEKeyHostSignals } from './e2ee-keypair-host-binding'

const MACHINE_A = 'a'.repeat(32)
const MACHINE_B = 'b'.repeat(32)

function linux(overrides: Partial<E2EEKeyHostSignals> = {}): E2EEKeyHostSignals {
  return {
    platform: 'linux',
    dataRootOnLocalDisk: true,
    machineId: MACHINE_A,
    inContainer: false,
    isWsl: false,
    hostname: 'devbox',
    ...overrides
  }
}

describe('e2eeKeyHostBinding', () => {
  it('binds nothing off Linux, on a shared disk, or without a machine-id', () => {
    expect(e2eeKeyHostBinding(linux({ platform: 'darwin' }))).toBeNull()
    expect(e2eeKeyHostBinding(linux({ platform: 'win32' }))).toBeNull()
    expect(e2eeKeyHostBinding(linux({ dataRootOnLocalDisk: false }))).toBeNull()
    expect(e2eeKeyHostBinding(linux({ machineId: null }))).toBeNull()
    expect(e2eeKeyHostBinding(linux({ inContainer: true }))).toBeNull()
  })

  it('tells Linux machines apart by machine-id alone, so a rename keeps the key', () => {
    const tag = e2eeKeyHostBinding(linux())
    expect(tag).toMatch(/^[A-Za-z0-9_-]{22}$/)
    expect(tag).not.toContain(MACHINE_A)
    expect(e2eeKeyHostBinding(linux({ hostname: 'renamed' }))).toBe(tag)
    expect(e2eeKeyHostBinding(linux({ machineId: MACHINE_B }))).not.toBe(tag)
  })

  it('tells a WSL distro exported to another computer apart by its hostname', () => {
    const tag = e2eeKeyHostBinding(linux({ isWsl: true, hostname: 'PC-ONE' }))
    expect(tag).not.toBeNull()
    expect(e2eeKeyHostBinding(linux({ isWsl: true, hostname: 'PC-TWO' }))).not.toBe(tag)
    // An empty machine-id later filled in by systemd must not move the key.
    expect(
      e2eeKeyHostBinding(linux({ isWsl: true, hostname: 'PC-ONE', machineId: null }))
    ).toBeNull()
    expect(e2eeKeyHostBinding(linux({ isWsl: true, hostname: '' }))).toBeNull()
  })
})
