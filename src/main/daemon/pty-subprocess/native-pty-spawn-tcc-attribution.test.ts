import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const spawnMock = vi.fn()
vi.mock('node-pty', () => ({ spawn: (...a: unknown[]) => spawnMock(...a) }))
vi.mock('../../windows/windows-pty-job', () => ({ assignHostProcessToKillOnCloseJob: vi.fn() }))

import { spawnNativeDaemonPty } from './native-pty-spawn'
import type { MacosTccSpawnStrategy } from '../../providers/macos-tcc-spawn-attribution'

const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform')

function setPlatform(value: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value, configurable: true })
}

function spawnedPty(extra: Record<string, unknown> = {}) {
  return { pid: 4242, onData: vi.fn(), onExit: vi.fn(), write: vi.fn(), kill: vi.fn(), ...extra }
}

function run(onMacosTccSpawnStrategy: (strategy: MacosTccSpawnStrategy) => void) {
  spawnNativeDaemonPty({
    shellPath: '/bin/zsh',
    shellArgs: ['-l'],
    spawnCwd: '/tmp',
    env: { SHELL: '/bin/zsh' },
    cols: 80,
    rows: 24,
    windowsFallbackAttempts: [],
    onMacosTccSpawnStrategy
  })
}

beforeEach(() => spawnMock.mockReset())
afterEach(() => {
  if (realPlatform) {
    Object.defineProperty(process, 'platform', realPlatform)
  }
})

describe('spawnNativeDaemonPty macOS TCC attribution reporting', () => {
  // Why: the verdict must come off the process node-pty actually returned, not
  // from the argv we asked for — `wrapped` never implied isolation (STA-3631).
  it('reports the disclaim verdict carried by the spawned process', () => {
    setPlatform('darwin')
    spawnMock.mockReturnValue(spawnedPty({ tccDisclaim: 1 }))
    const onMacosTccSpawnStrategy = vi.fn()
    run(onMacosTccSpawnStrategy)
    expect(onMacosTccSpawnStrategy).toHaveBeenCalledWith(
      expect.objectContaining({ attribution: 'disclaimed' })
    )
  })

  it('reports unknown when the spawned process carries no verdict', () => {
    setPlatform('darwin')
    spawnMock.mockReturnValue(spawnedPty())
    const onMacosTccSpawnStrategy = vi.fn()
    run(onMacosTccSpawnStrategy)
    expect(onMacosTccSpawnStrategy).toHaveBeenCalledWith(
      expect.objectContaining({ attribution: 'unknown' })
    )
  })

  it('reports not-disclaimed when the native spawn could not apply the attribute', () => {
    setPlatform('darwin')
    spawnMock.mockReturnValue(spawnedPty({ tccDisclaim: 2 }))
    const onMacosTccSpawnStrategy = vi.fn()
    run(onMacosTccSpawnStrategy)
    expect(onMacosTccSpawnStrategy).toHaveBeenCalledWith(
      expect.objectContaining({ attribution: 'not-disclaimed' })
    )
  })

  // Why: the wrapper decision and the disclaim verdict are independent facts.
  it('keeps the wrapper verdict separate from the attribution verdict', () => {
    setPlatform('darwin')
    spawnMock.mockReturnValue(spawnedPty({ tccDisclaim: 1 }))
    const onMacosTccSpawnStrategy = vi.fn()
    run(onMacosTccSpawnStrategy)
    expect(onMacosTccSpawnStrategy).toHaveBeenCalledWith({
      wrapper: 'direct',
      attribution: 'disclaimed'
    })
  })
})
