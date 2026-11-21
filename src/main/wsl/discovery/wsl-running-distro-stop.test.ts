import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  _resetRunningWslDistroCacheForTests,
  onRunningWslDistrosStopped,
  resolveRunningWslDistros
} from './wsl-running-distro-cache'

describe('onRunningWslDistrosStopped', () => {
  afterEach(() => {
    _resetRunningWslDistroCacheForTests()
    vi.restoreAllMocks()
  })

  it('reports distros a confirmed probe no longer lists', async () => {
    const listener = vi.fn()
    const unsubscribe = onRunningWslDistrosStopped(listener)
    await resolveRunningWslDistros(async () => ['Ubuntu', 'docker-desktop'])
    expect(listener).not.toHaveBeenCalled()
    await resolveRunningWslDistros(async () => ['ubuntu'])
    expect(listener).toHaveBeenCalledWith(['docker-desktop'], ['ubuntu'])
    unsubscribe()
  })

  it('ignores failed probes', async () => {
    const listener = vi.fn()
    const unsubscribe = onRunningWslDistrosStopped(listener)
    await resolveRunningWslDistros(async () => ['Ubuntu'])
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    await resolveRunningWslDistros(async () => {
      throw new Error('wsl.exe wedged')
    })
    expect(listener).not.toHaveBeenCalled()
    unsubscribe()
  })
})
