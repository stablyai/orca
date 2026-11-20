import { publishToDocuments, registerAppHandler } from '../app-registry/app-handler-registry'
import type { BrowserWindow } from 'electron'
import { randomUUID } from 'node:crypto'
import type { Store } from '../../persistence/loading-store/store'
import type { SparsePreset } from '../../../shared/worktree/create-types'
import {
  normalizeSparsePresetDirectories,
  normalizeSparsePresetName
} from './sparse-preset-validation'
import {
  SparsePresetValidationError,
  type SparsePresetFailure
} from '../../../shared/worktree/creation/sparse-preset-failure'
import { assertWslMoveProjectWritable } from '../../persistence/moving-wsl-projects/quiescence/wsl-move-scope-guard'

export function registerSparsePresetHandlers(mainWindow: BrowserWindow, store: Store): void {
  registerAppHandler('sparsePresets:list', (_event, args: { repoId: string }) => {
    return store.getSparsePresets(args.repoId)
  })

  registerAppHandler(
    'sparsePresets:save',
    (
      _event,
      args: { repoId: string; id?: string; name: string; directories: string[] }
    ): SparsePreset | SparsePresetFailure => {
      const repo = store.getRepo(args.repoId)
      if (!repo) {
        throw new Error(`Repo "${args.repoId}" not found`)
      }
      assertWslMoveProjectWritable(store, { repoId: args.repoId })
      let name: string
      let directories: string[]
      try {
        name = normalizeSparsePresetName(args.name)
        directories = normalizeSparsePresetDirectories(args.directories)
      } catch (error) {
        if (error instanceof SparsePresetValidationError) {
          return error.data
        }
        throw error
      }
      const now = Date.now()
      const existing = args.id
        ? store.getSparsePresets(args.repoId).find((preset) => preset.id === args.id)
        : undefined
      const preset: SparsePreset = {
        id: existing?.id ?? randomUUID(),
        repoId: args.repoId,
        name,
        directories,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now
      }
      const saved = store.saveSparsePreset(preset)
      notifySparsePresetsChanged(mainWindow, args.repoId)
      return saved
    }
  )

  registerAppHandler(
    'sparsePresets:remove',
    (_event, args: { repoId: string; presetId: string }) => {
      const repo = store.getRepo(args.repoId)
      if (!repo) {
        throw new Error(`Repo "${args.repoId}" not found`)
      }
      assertWslMoveProjectWritable(store, { repoId: args.repoId })
      store.removeSparsePreset(args.repoId, args.presetId)
      notifySparsePresetsChanged(mainWindow, args.repoId)
    }
  )
}

function notifySparsePresetsChanged(mainWindow: BrowserWindow, repoId: string): void {
  if (!mainWindow.isDestroyed()) {
    publishToDocuments('sparsePresets:changed', { repoId }, { sourceId: mainWindow.webContents.id })
  }
}
