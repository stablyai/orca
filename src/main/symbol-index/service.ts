import { readFile } from 'node:fs/promises'
import type { IpcMain } from 'electron'
import type { FindDefinitionsRequest, FindDefinitionsResponse } from '../../shared/symbol-index'
import { SYMBOL_INDEX_IPC } from '../../shared/symbol-index'
import { SymbolIndexStore } from './index-store'
import { parseDefinitions } from './parser'
import { languageIdForPath, listIndexableFiles } from './scan-worktree'

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
        this.store.setFileSymbols(worktreeId, `${root}/.orca-index-sentinel`, [])
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
    let source: string
    try {
      source = await readFile(abs, 'utf8')
    } catch {
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
      void this.ensureIndexed(req.worktreeId, req.worktreeRoot)
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
