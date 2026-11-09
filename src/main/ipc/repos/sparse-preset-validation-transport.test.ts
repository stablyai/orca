import { describe, expect, it, vi } from 'vitest'
import type { BrowserWindow } from 'electron'
import type { Store } from '../../persistence/loading-store/store'
import { registerSparsePresetHandlers } from './sparse-preset-handlers'
import { normalizeSparsePresetDirectories } from './sparse-preset-validation'
import { mapRuntimeError } from '../../runtime/rpc/errors'

const { handlers } = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, args: unknown) => unknown>()
}))
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, args: unknown) => unknown) =>
      handlers.set(channel, handler)
  }
}))
vi.mock('../../persistence/moving-wsl-projects/wsl-move-scope-guard', () => ({
  assertWslMoveProjectWritable: vi.fn()
}))

describe('sparse preset validation transport', () => {
  it('returns a structured IPC failure instead of saving an invalid preset', () => {
    const saveSparsePreset = vi.fn()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: validation only reads these store methods.
    const store = { getRepo: () => ({}), saveSparsePreset } as unknown as Store
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: invalid input returns before the window is accessed.
    registerSparsePresetHandlers({} as BrowserWindow, store)
    const result = handlers.get('sparsePresets:save')?.(undefined, {
      repoId: 'repo',
      name: '',
      directories: ['src']
    })
    expect(result).toEqual({ errorCode: 'name_required', error: 'Preset name is required.' })
    expect(saveSparsePreset).not.toHaveBeenCalled()
  })

  it('keeps the validation reason and legacy message in the RPC envelope', () => {
    let failure: unknown
    try {
      normalizeSparsePresetDirectories(['../outside'])
    } catch (error) {
      failure = error
    }
    expect(mapRuntimeError('request', { runtimeId: 'runtime' }, failure).error).toEqual({
      code: 'runtime_error',
      message: 'Preset directories must be repo-relative paths.',
      data: {
        errorCode: 'directories_invalid',
        error: 'Preset directories must be repo-relative paths.'
      }
    })
  })
})
