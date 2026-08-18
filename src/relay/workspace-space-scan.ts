/* eslint-disable max-lines -- Why: local and relay Space scans share the same
   cancellation, symlink, and top-level compaction semantics in one scanner. */
import { spawn, type ChildProcessByStdio } from 'node:child_process'
import type { Dirent } from 'node:fs'
import { lstat, opendir } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { platform } from 'node:process'
import type { Readable } from 'node:stream'
import { StringDecoder } from 'node:string_decoder'
import type {
  WorkspaceSpaceDirectoryScanResult,
  WorkspaceSpaceItem
} from '../shared/workspace-space-types'
import { compactWorkspaceSpaceItems } from '../shared/workspace-space-compaction'
import { mapWithConcurrency } from '../shared/map-with-concurrency'
import {
  scanWorkspaceSpaceEntryTree,
  type WorkspaceSpaceEntryScan
} from '../shared/workspace-space-entry-traversal'
import {
  collectWorkspaceSpaceDirectoryEntries,
  createWorkspaceSpaceScanBudget,
  retainWorkspaceSpaceScanEntry,
  type WorkspaceSpaceScanBudget,
  WorkspaceSpaceScanCapacityError
} from '../shared/workspace-space-scan-budget'
import type { RequestContext } from './dispatcher'

const RELAY_FS_CONCURRENCY = 48
const DU_TIMEOUT_MS = 120_000
const DU_STDERR_MAX_CHARS = 64 * 1024

type ScanStats = WorkspaceSpaceEntryScan

class RelayWorkspaceSpaceScanCancelledError extends Error {
  constructor() {
    super('Workspace space scan cancelled')
    this.name = 'RelayWorkspaceSpaceScanCancelledError'
  }
}

class RelayWorkspaceSpaceDuTimeoutError extends Error {
  constructor() {
    super(`du timed out after ${DU_TIMEOUT_MS}ms`)
    this.name = 'RelayWorkspaceSpaceDuTimeoutError'
  }
}

function throwIfCancelled(context: RequestContext): void {
  if (context.isStale() || context.signal?.aborted) {
    throw new RelayWorkspaceSpaceScanCancelledError()
  }
}

function normalizeDuPath(pathValue: string): string {
  const trimmed = pathValue.replace(/\/+$/, '')
  return trimmed.length > 0 ? trimmed : pathValue
}

function parseDuDepthOneLine(line: string): [string, number] | null {
  const normalizedLine = line.endsWith('\r') ? line.slice(0, -1) : line
  if (!normalizedLine) {
    return null
  }
  const match = /^(\d+)\s+(.+)$/.exec(normalizedLine)
  if (!match) {
    return null
  }
  return [normalizeDuPath(match[2]), Number(match[1]) * 1024]
}

function consumeDuOutputChunk(
  sizes: Map<string, number>,
  budget: WorkspaceSpaceScanBudget,
  bufferedLine: string,
  chunkText: string
): string {
  const lines = `${bufferedLine}${chunkText}`.split('\n')
  const nextBufferedLine = lines.pop() ?? ''
  for (const line of lines) {
    const parsed = parseDuDepthOneLine(line)
    if (parsed) {
      if (!sizes.has(parsed[0])) {
        retainWorkspaceSpaceScanEntry(budget, parsed[0], sizes.size)
      }
      sizes.set(parsed[0], parsed[1])
    }
  }
  return nextBufferedLine
}

async function readDuDepthOne(
  rootPath: string,
  context: RequestContext
): Promise<Map<string, number>> {
  throwIfCancelled(context)
  return new Promise<Map<string, number>>((resolve, reject) => {
    let settled = false
    let child: ChildProcessByStdio<null, Readable, Readable> | undefined
    let onAbort: (() => void) | null = null
    let timer: ReturnType<typeof setTimeout> | null = null
    let bufferedLine = ''
    let stderr = ''
    const stdoutDecoder = new StringDecoder('utf8')
    const stderrDecoder = new StringDecoder('utf8')
    const sizes = new Map<string, number>()
    const budget = createWorkspaceSpaceScanBudget()
    const appendStderr = (chunkText: string): void => {
      if (stderr.length < DU_STDERR_MAX_CHARS) {
        stderr = `${stderr}${chunkText}`.slice(0, DU_STDERR_MAX_CHARS)
      }
    }
    const settle = (callback: () => void): void => {
      if (settled) {
        return
      }
      settled = true
      if (timer) {
        clearTimeout(timer)
      }
      if (onAbort) {
        context.signal?.removeEventListener('abort', onAbort)
      }
      callback()
    }
    onAbort = () => {
      settle(() => {
        child?.kill()
        reject(new RelayWorkspaceSpaceScanCancelledError())
      })
    }
    context.signal?.addEventListener('abort', onAbort, { once: true })
    if (context.signal?.aborted || context.isStale()) {
      onAbort()
      return
    }

    try {
      // Why: stream beyond execFile's fixed buffer while bounding retained rows.
      child = spawn('du', ['-k', '-d', '1', rootPath], { stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      settle(() => reject(error))
      return
    }
    timer = setTimeout(() => {
      settle(() => {
        child?.kill()
        reject(new RelayWorkspaceSpaceDuTimeoutError())
      })
    }, DU_TIMEOUT_MS)
    child.stdout.on('data', (chunk) => {
      if (settled) {
        return
      }
      try {
        bufferedLine = consumeDuOutputChunk(sizes, budget, bufferedLine, stdoutDecoder.write(chunk))
      } catch (error) {
        settle(() => {
          child?.kill()
          reject(error)
        })
      }
    })
    child.stderr.on('data', (chunk) => {
      appendStderr(stderrDecoder.write(chunk))
    })
    child.once('error', (error) => {
      settle(() => reject(error))
    })
    child.once('close', (code) => {
      if (settled) {
        return
      }
      try {
        const decodedTail = stdoutDecoder.end()
        if (decodedTail) {
          bufferedLine = consumeDuOutputChunk(sizes, budget, bufferedLine, decodedTail)
        }
        appendStderr(stderrDecoder.end())
        const parsed = parseDuDepthOneLine(bufferedLine)
        if (parsed) {
          if (!sizes.has(parsed[0])) {
            retainWorkspaceSpaceScanEntry(budget, parsed[0], sizes.size)
          }
          sizes.set(parsed[0], parsed[1])
        }
      } catch (error) {
        settle(() => reject(error))
        return
      }
      settle(() => {
        if (code === 0) {
          resolve(sizes)
          return
        }
        reject(new Error(stderr.trim() || `du exited with code ${code ?? 'null'}`))
      })
    })
  })
}

function toWorkspaceSpaceItem(stats: ScanStats): WorkspaceSpaceItem {
  return {
    name: stats.name,
    path: stats.path,
    kind: stats.kind,
    sizeBytes: stats.sizeBytes
  }
}

async function scanTopLevelEntryWithDu(
  entryPath: string,
  name: string,
  duSizes: Map<string, number>,
  context: RequestContext
): Promise<ScanStats> {
  throwIfCancelled(context)
  const stats = await lstat(entryPath)
  throwIfCancelled(context)

  if (stats.isSymbolicLink()) {
    return {
      name,
      path: entryPath,
      kind: 'symlink',
      sizeBytes: stats.size,
      skippedEntryCount: 0
    }
  }

  if (!stats.isDirectory()) {
    return {
      name,
      path: entryPath,
      kind: 'file',
      sizeBytes: stats.size,
      skippedEntryCount: 0
    }
  }

  return {
    name,
    path: entryPath,
    kind: 'directory',
    sizeBytes: duSizes.get(normalizeDuPath(entryPath)) ?? stats.size,
    skippedEntryCount: 0
  }
}

async function scanEntryAggregate(
  entryPath: string,
  name: string,
  context: RequestContext
): Promise<ScanStats> {
  return scanWorkspaceSpaceEntryTree<Dirent>({
    rootPath: entryPath,
    rootName: name,
    concurrency: RELAY_FS_CONCURRENCY,
    signal: context.signal,
    entryName: (entry) => entry.name,
    joinPath: join,
    classifyEntry: async (path) => {
      const stats = await lstat(path)
      throwIfCancelled(context)
      if (stats.isSymbolicLink()) {
        return { kind: 'symlink', sizeBytes: stats.size }
      }
      return stats.isDirectory()
        ? { kind: 'directory', sizeBytes: stats.size }
        : { kind: 'file', sizeBytes: stats.size }
    },
    readDirectory: (path) => opendir(path),
    checkCancelled: () => throwIfCancelled(context),
    createCancellationError: () => new RelayWorkspaceSpaceScanCancelledError(),
    isCancellationError: (error) => error instanceof RelayWorkspaceSpaceScanCancelledError
  })
}

async function scanDirectoryWithDu(
  rootPath: string,
  context: RequestContext
): Promise<WorkspaceSpaceDirectoryScanResult> {
  throwIfCancelled(context)
  const rootStats = await lstat(rootPath)
  throwIfCancelled(context)
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
    return scanDirectoryWithNode(rootPath, context)
  }

  const directory = await opendir(rootPath)
  const admission = await collectWorkspaceSpaceDirectoryEntries(
    directory,
    rootPath,
    (entry) => entry.name,
    createWorkspaceSpaceScanBudget(),
    () => throwIfCancelled(context)
  )
  const entries = admission.entries
  const duSizes = await readDuDepthOne(rootPath, context)
  throwIfCancelled(context)
  const childStats = await mapWithConcurrency(
    entries,
    RELAY_FS_CONCURRENCY,
    async (entry): Promise<ScanStats | null> => {
      try {
        return await scanTopLevelEntryWithDu(
          join(rootPath, entry.name),
          entry.name,
          duSizes,
          context
        )
      } catch (error) {
        if (error instanceof RelayWorkspaceSpaceScanCancelledError) {
          throw error
        }
        return null
      }
    }
  )
  const children = childStats.filter((child): child is ScanStats => child !== null)
  const compact = compactWorkspaceSpaceItems(children.map(toWorkspaceSpaceItem))

  return {
    sizeBytes:
      duSizes.get(normalizeDuPath(rootPath)) ??
      rootStats.size + children.reduce((sum, child) => sum + child.sizeBytes, 0),
    skippedEntryCount: childStats.length - children.length,
    ...compact
  }
}

async function scanDirectoryWithNode(
  rootPath: string,
  context: RequestContext
): Promise<WorkspaceSpaceDirectoryScanResult> {
  const root = await scanEntryAggregate(rootPath, basename(rootPath), context)
  const children = root.children ?? []
  const compact = compactWorkspaceSpaceItems(children.map(toWorkspaceSpaceItem))

  return {
    sizeBytes: root.sizeBytes,
    skippedEntryCount: root.skippedEntryCount,
    ...compact
  }
}

export async function scanWorkspaceSpaceDirectory(
  rootPath: string,
  context: RequestContext
): Promise<WorkspaceSpaceDirectoryScanResult> {
  if (platform !== 'win32') {
    try {
      return await scanDirectoryWithDu(rootPath, context)
    } catch (error) {
      if (
        error instanceof RelayWorkspaceSpaceScanCancelledError ||
        error instanceof RelayWorkspaceSpaceDuTimeoutError ||
        error instanceof WorkspaceSpaceScanCapacityError
      ) {
        throw error
      }
    }
  }
  return scanDirectoryWithNode(rootPath, context)
}
