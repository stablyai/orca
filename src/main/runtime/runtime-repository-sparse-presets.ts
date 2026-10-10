import { randomUUID } from 'node:crypto'
import type { Repo } from '../../shared/repo-types'
import { normalizeSparseDirectories } from '../ipc/sparse-checkout-directories'
import type { RuntimeStore } from './runtime-store-contract'

type RuntimeRepositorySparsePresetDependencies = {
  getStore: () => RuntimeStore | null
  resolveRepo: (selector: string) => Promise<Repo>
}

function normalizeName(name: string): string {
  const trimmed = name.trim()
  if (!trimmed) {
    throw new Error('Preset name is required.')
  }
  if (trimmed.length > 80) {
    throw new Error('Preset name is too long.')
  }
  return trimmed
}

function normalizeDirectories(directories: string[]): string[] {
  let normalized: string[]
  try {
    normalized = normalizeSparseDirectories(directories)
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === 'Sparse checkout directories must be repo-relative paths.'
    ) {
      throw new Error('Preset directories must be repo-relative paths.')
    }
    throw error
  }
  if (normalized.length === 0) {
    throw new Error('Preset must have at least one directory.')
  }
  return normalized
}

export class RuntimeRepositorySparsePresets {
  constructor(private readonly deps: RuntimeRepositorySparsePresetDependencies) {}

  async list(repoSelector: string) {
    const store = this.deps.getStore()
    if (!store?.getSparsePresets) {
      throw new Error('runtime_unavailable')
    }
    const repo = await this.deps.resolveRepo(repoSelector)
    return store.getSparsePresets(repo.id)
  }

  async save(repoSelector: string, args: { id?: string; name: string; directories: string[] }) {
    const store = this.deps.getStore()
    if (!store?.getSparsePresets || !store.saveSparsePreset) {
      throw new Error('runtime_unavailable')
    }
    const repo = await this.deps.resolveRepo(repoSelector)
    const name = normalizeName(args.name)
    const directories = normalizeDirectories(args.directories)
    const now = Date.now()
    const existing = args.id
      ? store.getSparsePresets(repo.id).find((preset) => preset.id === args.id)
      : undefined
    return store.saveSparsePreset({
      id: existing?.id ?? randomUUID(),
      repoId: repo.id,
      name,
      directories,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now
    })
  }
}
