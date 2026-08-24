import { describe, expect, it, vi } from 'vitest'
import { createOrcaBackgroundApi } from './orca-background-api'

describe('Orca background preload API', () => {
  it('keeps filesystem operations on dedicated IPC channels', async () => {
    const invoke = vi.fn().mockResolvedValue(undefined)
    const api = createOrcaBackgroundApi({ invoke } as never)

    await api.listLibrary()
    await api.addImages()
    await api.openLibrary()
    await api.loadImage('scene.png')

    expect(invoke.mock.calls).toEqual([
      ['backgrounds:listLibrary'],
      ['backgrounds:addImages'],
      ['backgrounds:openLibrary'],
      ['backgrounds:loadImage', 'scene.png']
    ])
  })
})
