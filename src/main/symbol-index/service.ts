import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import type { IpcMain } from 'electron'
import type { FindDefinitionsRequest, FindDefinitionsResponse } from '../../shared/symbol-index'
import { SYMBOL_INDEX_IPC } from '../../shared/symbol-index'
import { SymbolIndexStore } from './index-store'
import { parseDefinitions } from './parser'
import { languageIdForPath, listIndexableFiles } from './scan-worktree'

// Why: a single huge file (e.g. a committed/generated multi-MB source file)
// would be tree-sitter-parsed synchronously on the Electron main thread,
// blocking the UI and risking an OOM. Skip files above this size instead.
const MAX_INDEXABLE_FILE_BYTES = 2_000_000

type Deps = { maxFiles?: number }

export class SymbolIndexService {
  private store = new SymbolIndexStore()
  private indexing = new Map<string, Promise<void>>()
  private maxFiles: number

  constructor(deps: Deps = {}) {
    this.maxFiles = deps.maxFiles ?? 20_000
  }

  async ensureIndexed(worktreeId: string, root: string): Promise<void> {
    if (this.store.hasWorktree(worktreeId)) {
      return
    }
    let job = this.indexing.get(worktreeId)
    if (!job) {
      job = this.indexWorktree(worktreeId, root)
      this.indexing.set(worktreeId, job)
    }
    await job
  }

  private async indexWorktree(worktreeId: string, root: string): Promise<void> {
    try {
      const files = await listIndexableFiles(root, { maxFiles: this.maxFiles })
      for (const abs of files) {
        await this.indexFile(worktreeId, abs)
      }
      // Ensure the worktree is registered even if it had zero indexable files.
      if (!this.store.hasWorktree(worktreeId)) {
        this.store.setFileSymbols(worktreeId, path.join(root, '.orca-index-sentinel'), [])
      }
    } finally {
      this.indexing.delete(worktreeId)
    }
  }

  private async indexFile(worktreeId: string, abs: string): Promise<void> {
    const languageId = languageIdForPath(abs)
    if (!languageId) {
      return
    }
    // Why: each early return below must also drop any symbols previously
    // indexed for this path. Otherwise onFileChanged on a file that has grown
    // past the size cap or been deleted would leave stale definitions in the
    // store, so findDefinitions would return outdated locations.
    try {
      const info = await stat(abs)
      if (info.size > MAX_INDEXABLE_FILE_BYTES) {
        this.store.removeFile(worktreeId, abs)
        return
      }
    } catch {
      this.store.removeFile(worktreeId, abs)
      return
    }
    let source: string
    try {
      source = await readFile(abs, 'utf8')
    } catch {
      this.store.removeFile(worktreeId, abs)
      return
    }
    const defs = await parseDefinitions(languageId, source, abs)
    this.store.setFileSymbols(worktreeId, abs, defs)
  }

  async onFileChanged(worktreeId: string, root: string, abs: string): Promise<void> {
    if (!this.store.hasWorktree(worktreeId)) {
      await this.ensureIndexed(worktreeId, root)
      return
    }
    await this.indexFile(worktreeId, abs)
  }

  onFileRemoved(worktreeId: string, abs: string): void {
    this.store.removeFile(worktreeId, abs)
  }

  async findDefinitions(req: FindDefinitionsRequest): Promise<FindDefinitionsResponse> {
    if (!this.store.hasWorktree(req.worktreeId)) {
      // Kick off indexing in the background; tell the caller to fall back now.
      // Why: this is fire-and-forget, so guard against an unhandled promise
      // rejection reaching the Electron main process if indexing ever throws.
      void this.ensureIndexed(req.worktreeId, req.worktreeRoot).catch(() => {})
      return { status: 'indexing', definitions: [] }
    }
    return { status: 'ready', definitions: this.store.find(req.worktreeId, req.symbol) }
  }

  registerIpcHandlers(): void {
    // Lazy require keeps this module unit-testable without Electron.
    const { ipcMain } = require('electron') as { ipcMain: IpcMain }
    ipcMain.handle(SYMBOL_INDEX_IPC.findDefinitions, (_e, req: FindDefinitionsRequest) =>
      this.findDefinitions(req)
    )
    ipcMain.handle(
      SYMBOL_INDEX_IPC.ensureIndexed,
      (_e, args: { worktreeId: string; worktreeRoot: string }) =>
        this.ensureIndexed(args.worktreeId, args.worktreeRoot)
    )
  }

  dispose(): void {
    this.indexing.clear()
  }
}
