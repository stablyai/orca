import { afterEach, describe, expect, it, vi } from 'vitest'

const { readFileSyncMock } = vi.hoisted(() => ({ readFileSyncMock: vi.fn() }))
vi.mock('node:fs', () => ({ readFileSync: readFileSyncMock, rmSync: vi.fn(), statSync: vi.fn() }))

import { probeDisplayLock } from './x-display-artifacts'

const originalPlatform = process.platform

afterEach(() => {
  vi.restoreAllMocks()
  readFileSyncMock.mockReset()
  Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
})

function procStat(pid: number, state: string, command = 'Xvfb (worker)'): string {
  return `${pid} (${command}) ${state} ${Array(49).fill('0').join(' ')}`
}

function linuxProcess(state: string): void {
  Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
  readFileSyncMock.mockImplementation((path: string) => {
    if (path === '/tmp/.X99-lock') {
      return '4321\n'
    }
    if (path === '/proc/4321/stat') {
      return procStat(4321, state)
    }
    throw new Error(`Unexpected path: ${path}`)
  })
  vi.spyOn(process, 'kill').mockReturnValue(true)
}

describe('X display process liveness', () => {
  it('rejects an unreaped zombie even though signal 0 succeeds', () => {
    linuxProcess('Z')
    expect(probeDisplayLock(99)).toBe('dead')
  })

  it.each(['R', 'S', 'T'])('retains a process in state %s', (state) => {
    linuxProcess(state)
    expect(probeDisplayLock(99)).toBe('alive')
  })

  it.each(['EACCES', 'ENOENT'])('retains signal evidence when proc is %s', (code) => {
    linuxProcess('S')
    readFileSyncMock.mockImplementation((path: string) => {
      if (path === '/tmp/.X99-lock') {
        return '4321\n'
      }
      throw Object.assign(new Error(code), { code })
    })
    expect(probeDisplayLock(99)).toBe('alive')
  })

  it.each([
    'not a proc stat record',
    'garbage) Z',
    '4321 (Xvfb) Z',
    `4321 (Xvfb) Z ${Array(48).fill('0').join(' ')}`,
    procStat(4322, 'Z'),
    procStat(4321, 'ZZ'),
    procStat(4321, 'Z').replace(/0$/, 'invalid'),
    procStat(4321, 'Z').replace(') Z', ')Z'),
    procStat(4321, 'Z').replace(' (', ' ')
  ])('retains signal evidence for malformed or mismatched proc: %s', (stat) => {
    linuxProcess('S')
    readFileSyncMock.mockImplementation((path: string) =>
      path === '/tmp/.X99-lock' ? '4321\n' : stat
    )
    expect(probeDisplayLock(99)).toBe('alive')
  })

  it.each(['Xvfb (worker)', 'Xvfb) Z (worker', 'Xvfb with spaces'])(
    'recognizes a complete zombie record with command %s',
    (command) => {
      linuxProcess('Z')
      readFileSyncMock.mockImplementation((path: string) =>
        path === '/tmp/.X99-lock' ? '4321\n' : procStat(4321, 'Z', command)
      )
      expect(probeDisplayLock(99)).toBe('dead')
    }
  )

  it('accepts signed and large numeric fields and future appended fields', () => {
    linuxProcess('Z')
    const stat = `${procStat(4321, 'Z')} -1 18446744073709551615`
    readFileSyncMock.mockImplementation((path: string) =>
      path === '/tmp/.X99-lock' ? '4321\n' : stat
    )
    expect(probeDisplayLock(99)).toBe('dead')
  })

  it.each([
    ['S', 'alive'],
    ['Z', 'dead']
  ] as const)('checks state %s even when signal 0 is permission-denied', (state, expected) => {
    linuxProcess(state)
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('not permitted'), { code: 'EPERM' })
    })
    expect(probeDisplayLock(99)).toBe(expected)
  })

  it('does not read Linux proc on other platforms', () => {
    linuxProcess('Z')
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
    expect(probeDisplayLock(99)).toBe('alive')
    expect(readFileSyncMock).not.toHaveBeenCalledWith('/proc/4321/stat', 'utf8')
  })
})
