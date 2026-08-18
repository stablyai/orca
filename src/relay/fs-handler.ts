import { tmpdir } from 'node:os'
import type { RelayDispatcher, RequestContext } from './dispatcher'
import type { RelayContext } from './context'
// Why: RelayContext is accepted in the constructor for protocol back-compat
// (see docs/relay-fs-allowlist-removal.md), but no longer consulted on FS ops.
import { expandTilde } from './context'
import { DEFAULT_MAX_RESULTS, searchWithRg } from './fs-handler-utils'
import { searchWithGitGrep } from './fs-handler-git-fallback'
import { ListFilesScanCoordinator } from './fs-list-files-scan-coordinator'
import { runListFilesScan } from './fs-list-files-fallback-chain'
import {
  lstatRelayPath,
  readRelayDir,
  realpathRelayPath,
  statRelayPath
} from './fs-path-metadata-requests'
import {
  copyRelayPath,
  createRelayDir,
  createRelayDirNoClobber,
  createRelayFile,
  deleteRelayPath,
  renameRelayPath,
  renameRelayPathNoClobber,
  writeRelayFile
} from './fs-path-mutation-requests'
import { buildExcludePathPrefixes } from '../shared/quick-open-filter'
import { readRelayFileContent, readRelayFileStreamMetadata } from './fs-handler-file-read'
import {
  readVerifiedTerminalArtifact,
  writeVerifiedTerminalArtifact
} from './fs-handler-terminal-artifact'
import { RelayStreamRegistry } from './fs-stream-registry'
import { scanWorkspaceSpaceDirectory } from './workspace-space-scan'
import { RipgrepUnavailableError } from '../shared/ripgrep-process-availability'
import { RelayFilesystemWatchRegistry } from './relay-filesystem-watch-registry'
import type { RelayWatcherProcessPool } from './relay-watcher-process-pool'

export class FsHandler {
  private dispatcher: RelayDispatcher
  private watchRegistry: RelayFilesystemWatchRegistry
  private streamRegistry = new RelayStreamRegistry()
  private listFilesScans = new ListFilesScanCoordinator()

  constructor(
    dispatcher: RelayDispatcher,
    _context: RelayContext,
    watcherPool?: RelayWatcherProcessPool
  ) {
    this.dispatcher = dispatcher
    this.watchRegistry = new RelayFilesystemWatchRegistry(dispatcher, watcherPool)
    this.registerHandlers()
    this.dispatcher.onClientDetached?.(() => {
      // Why: a detached client's fs.streamAck frames will never arrive; wake
      // any pump parked on the ack window so it re-checks staleness and exits
      // instead of stranding its open file handle.
      this.streamRegistry.wakeAllAckWaiters()
    })
  }

  getWatchRegistry(): RelayFilesystemWatchRegistry {
    return this.watchRegistry
  }

  private registerHandlers(): void {
    this.dispatcher.onRequest('fs.readDir', (p) => readRelayDir(p))
    this.dispatcher.onRequest('fs.readFile', (p) => this.readFile(p))
    this.dispatcher.onRequest('fs.readFileStream', (p, c) => this.readFileStream(p, c))
    this.dispatcher.onRequest('fs.readTerminalArtifact', (p) => this.readTerminalArtifact(p))
    this.dispatcher.onRequest('fs.tempDir', () => this.tempDir())
    this.dispatcher.onRequest('fs.writeFile', (p) => writeRelayFile(p))
    this.dispatcher.onRequest('fs.writeTerminalArtifact', (p) => this.writeTerminalArtifact(p))
    this.dispatcher.onRequest('fs.stat', (p) => statRelayPath(p))
    this.dispatcher.onRequest('fs.lstat', (p) => lstatRelayPath(p))
    this.dispatcher.onRequest('fs.deletePath', (p) => deleteRelayPath(p, this.watchRegistry))
    this.dispatcher.onRequest('fs.createFile', (p) => createRelayFile(p))
    this.dispatcher.onRequest('fs.createDir', (p) => createRelayDir(p))
    this.dispatcher.onRequest('fs.createDirNoClobber', (p) => createRelayDirNoClobber(p))
    this.dispatcher.onRequest('fs.rename', (p) => renameRelayPath(p))
    this.dispatcher.onRequest('fs.renameNoClobber', (p) => renameRelayPathNoClobber(p))
    this.dispatcher.onRequest('fs.copy', (p) => copyRelayPath(p))
    this.dispatcher.onRequest('fs.realpath', (p) => realpathRelayPath(p))
    this.dispatcher.onRequest('fs.search', (p) => this.search(p))
    this.dispatcher.onRequest('fs.getCapabilities', async () => ({
      quickOpenSearchVersion: 1
    }))
    this.dispatcher.onRequest('fs.listFiles', (p, c) => this.listFiles(p, c))
    this.dispatcher.onRequest('fs.workspaceSpaceScan', (p, c) => this.workspaceSpaceScan(p, c))
    this.dispatcher.onRequest('fs.watch', (p, context) =>
      this.watchRegistry.watch(
        expandTilde(p.rootPath as string),
        context,
        typeof p.watchId === 'number' && Number.isSafeInteger(p.watchId) ? p.watchId : undefined
      )
    )
    this.dispatcher.onRequest('fs.unwatchAndWait', (p, context) =>
      this.watchRegistry.unwatchAndWait(expandTilde(p.rootPath as string), context)
    )
    this.dispatcher.onNotification('fs.unwatch', (p, context) =>
      this.watchRegistry.unwatch(expandTilde(p.rootPath as string), context)
    )
    this.dispatcher.onNotification('fs.cancelStream', (p) => this.cancelStream(p))
    this.dispatcher.onNotification('fs.streamAck', (p) => this.streamAck(p))
  }

  private async readFile(params: Record<string, unknown>) {
    const filePath = expandTilde(params.filePath as string)
    return readRelayFileContent(filePath)
  }

  private async readTerminalArtifact(params: Record<string, unknown>) {
    return readVerifiedTerminalArtifact({
      ...params,
      filePath: expandTilde(params.filePath as string)
    })
  }

  private async readFileStream(params: Record<string, unknown>, context?: RequestContext) {
    const filePath = expandTilde(params.filePath as string)
    const ctx = context ?? { clientId: 0, isStale: () => false }
    return readRelayFileStreamMetadata(filePath, this.dispatcher, this.streamRegistry, ctx, {
      // Why: only target the requesting client when the dispatcher actually
      // routed this request (context present) — direct-call tests and legacy
      // paths keep broadcast semantics.
      ...(context ? { clientId: context.clientId } : {}),
      paceWithAcks: params.flowControl === 'ack'
    })
  }

  private async tempDir(): Promise<string> {
    return tmpdir()
  }

  private cancelStream(params: Record<string, unknown>): void {
    const streamId = params.streamId as number | undefined
    if (typeof streamId === 'number') {
      this.streamRegistry.abort(streamId)
    }
  }

  private streamAck(params: Record<string, unknown>): void {
    const streamId = params.streamId as number | undefined
    const seq = params.seq as number | undefined
    if (typeof streamId === 'number' && typeof seq === 'number') {
      this.streamRegistry.recordAck(streamId, seq)
    }
  }

  private async writeTerminalArtifact(params: Record<string, unknown>) {
    return writeVerifiedTerminalArtifact({
      ...params,
      filePath: expandTilde(params.filePath as string)
    })
  }

  private async search(params: Record<string, unknown>) {
    const query = params.query as string
    const rootPath = expandTilde(params.rootPath as string)
    const caseSensitive = params.caseSensitive as boolean | undefined
    const wholeWord = params.wholeWord as boolean | undefined
    const useRegex = params.useRegex as boolean | undefined
    const includePattern = params.includePattern as string | undefined
    const excludePattern = params.excludePattern as string | undefined
    const maxResults = Math.min(
      (params.maxResults as number) || DEFAULT_MAX_RESULTS,
      DEFAULT_MAX_RESULTS
    )

    const options = {
      caseSensitive,
      wholeWord,
      useRegex,
      includePattern,
      excludePattern,
      maxResults
    }
    try {
      return await searchWithRg(rootPath, query, options)
    } catch (error) {
      if (!(error instanceof RipgrepUnavailableError)) {
        throw error
      }
      return searchWithGitGrep(rootPath, query, options)
    }
  }

  private listFiles(params: Record<string, unknown>, context?: RequestContext): Promise<string[]> {
    const rootPath = expandTilde(params.rootPath as string)
    const maxResults =
      typeof params.maxResults === 'number' &&
      Number.isInteger(params.maxResults) &&
      params.maxResults > 0
        ? Math.min(params.maxResults, 20_001)
        : undefined
    const searchQuery =
      typeof params.searchQuery === 'string' && params.searchQuery.trim().length > 0
        ? params.searchQuery
        : undefined
    // Why: the main-to-relay RPC adds excludePaths so nested linked worktrees
    // don't get double-scanned. The shared helper validates the shape and
    // normalizes into root-relative prefixes; malformed input yields [] so
    // the request still succeeds (older apps omit the field entirely).
    const excludePathPrefixes = buildExcludePathPrefixes(rootPath, params.excludePaths)
    // Why #7721: full-tree scans are the relay's most expensive request; the
    // coordinator caps them at one per client, coalescing duplicates and
    // aborting a stale scan when the workspace changes or the host cancels.
    return this.listFilesScans.run({
      clientId: context?.clientId ?? 0,
      key: JSON.stringify([rootPath, excludePathPrefixes, maxResults, searchQuery]),
      signal: context?.signal,
      start: (signal) =>
        runListFilesScan(rootPath, excludePathPrefixes, signal, maxResults, searchQuery)
    })
  }

  private async workspaceSpaceScan(params: Record<string, unknown>, context: RequestContext) {
    const rootPath = expandTilde(params.rootPath as string)
    return scanWorkspaceSpaceDirectory(rootPath, context)
  }

  dispose(): void {
    this.watchRegistry.dispose()
    void this.streamRegistry.disposeAll()
  }
}
