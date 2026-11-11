import { SparsePresetValidationError } from '../../../shared/worktree/sparse-preset-failure'
import {
  InvalidSparseDirectoryError,
  normalizeSparseDirectories
} from '../sparse-checkout-directories'

export function normalizeSparsePresetName(name: string): string {
  const trimmed = name.trim()
  if (!trimmed) {
    throw new SparsePresetValidationError('name_required')
  }
  if (trimmed.length > 80) {
    throw new SparsePresetValidationError('name_too_long')
  }
  return trimmed
}

export function normalizeSparsePresetDirectories(directories: string[]): string[] {
  let normalized: string[]
  try {
    normalized = normalizeSparseDirectories(directories)
  } catch (error) {
    if (error instanceof InvalidSparseDirectoryError) {
      throw new SparsePresetValidationError('directories_invalid')
    }
    throw error
  }
  if (normalized.length === 0) {
    throw new SparsePresetValidationError('directories_required')
  }
  return normalized
}
