import { describe, expect, it, vi } from 'vitest'
import type { BrowserWindow } from 'electron'
import type { Store } from '../../persistence/loading-store/store'
import { registerSparsePresetHandlers } from './sparse-preset-handlers'
import { normalizeSparsePresetDirectories } from './sparse-preset-validation'
import { mapRuntimeError } from '../../runtime/rpc/errors'
import {
  InvalidSparseDirectoryError,
  normalizeSparseDirectories
} from '../sparse-checkout-directories'

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
  it('identifies both absolute and parent-segment directory failures by type', () => {
    expect(() => normalizeSparseDirectories(['/outside'])).toThrow(InvalidSparseDirectoryError)
    expect(() => normalizeSparseDirectories(['../outside'])).toThrow(InvalidSparseDirectoryError)
  })

  it.each([
    { name: '', directories: ['src'], code: 'name_required' },
    { name: 'a'.repeat(81), directories: ['src'], code: 'name_too_long' },
    { name: 'Preset', directories: [], code: 'directories_required' },
    { name: 'Preset', directories: ['../outside'], code: 'directories_invalid' },
    { name: 'Preset', directories: ['/outside'], code: 'directories_invalid' }
  ])(
    'returns IPC code $code instead of saving an invalid preset',
    ({ name, directories, code }) => {
      const saveSparsePreset = vi.fn()
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: validation only reads these store methods.
      const store = { getRepo: () => ({}), saveSparsePreset } as unknown as Store
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: invalid input returns before the window is accessed.
      registerSparsePresetHandlers({} as BrowserWindow, store)
      const result = handlers.get('sparsePresets:save')?.(undefined, {
        repoId: 'repo',
        name,
        directories
      })
      expect(result).toMatchObject({ errorCode: code })
      expect(saveSparsePreset).not.toHaveBeenCalled()
    }
  )

  it('keeps the validation reason in the RPC envelope', () => {
    let failure: unknown
    try {
      normalizeSparsePresetDirectories(['../outside'])
    } catch (error) {
      failure = error
    }
    expect(mapRuntimeError('request', { runtimeId: 'runtime' }, failure).error).toMatchObject({
      code: 'runtime_error',
      data: {
        errorCode: 'directories_invalid'
      }
    })
  })
})
