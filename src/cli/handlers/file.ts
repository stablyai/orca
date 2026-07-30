import type { GitStatusEntry, GitStatusResult } from '../../shared/git-status-types'
import type { RuntimeFileOpenResult, RuntimeWorktreeRecord } from '../../shared/runtime-types'
import { isRuntimePathAbsolute, relativePathInsideRoot } from '../../shared/cross-platform-path'
import type { CommandHandler, HandlerContext } from '../dispatch'
import { getOptionalStringFlag, getRequiredStringFlag } from '../flags'
import { printResult } from '../format'
import { RuntimeClientError } from '../runtime-client'
import { getOptionalWorktreeSelector, resolveCurrentWorktreeSelector } from '../selectors'

type FileOpenMode = 'edit' | 'diff'
type OpenChangedMode = FileOpenMode | 'both'

type FileOpenRecord = {
  path: string
  mode: FileOpenMode
  staged?: boolean
  opened: boolean
  kind?: RuntimeFileOpenResult['kind']
  skipped?: boolean
  reason?: string
}

type FileOpenChangedResult = {
  worktree: string
  mode: OpenChangedMode
  opened: FileOpenRecord[]
  skipped: FileOpenRecord[]
  totalChanged: number
}

async function getFileWorktreeSelector({ flags, cwd, client }: HandlerContext): Promise<string> {
  const worktree = flags.get('worktree')
  if (flags.has('worktree') && (typeof worktree !== 'string' || worktree.length === 0)) {
    throw new RuntimeClientError('invalid_argument', 'Missing value for --worktree.')
  }
  const explicit = await getOptionalWorktreeSelector(flags, 'worktree', cwd, client)
  if (explicit) {
    return explicit
  }
  if (client.isRemote) {
    throw new RuntimeClientError(
      'invalid_argument',
      'Remote file commands require --worktree because the client cwd cannot identify a server worktree.'
    )
  }
  return await resolveCurrentWorktreeSelector(cwd, client)
}

async function resolveFilePath(
  ctx: HandlerContext,
  worktree: string,
  path: string
): Promise<string> {
  if (!isRuntimePathAbsolute(path)) {
    return path
  }
  // Why: only in-worktree absolute paths should be relativized here; outside paths must reach the runtime guard unchanged.
  const result = await ctx.client.call<{ worktree: RuntimeWorktreeRecord }>('worktree.show', {
    worktree
  })
  const relativePath = relativePathInsideRoot(result.result.worktree.path, path)
  if (relativePath === '') {
    throw new RuntimeClientError(
      'invalid_argument',
      'The selected worktree root is a directory, not a file-open target.'
    )
  }
  return relativePath ?? path
}

function getOpenChangedMode(flags: Map<string, string | boolean>): OpenChangedMode {
  const value = flags.get('mode')
  if (flags.has('mode') && (typeof value !== 'string' || value.length === 0)) {
    throw new RuntimeClientError(
      'invalid_argument',
      'Missing value for --mode. Use edit, diff, or both.'
    )
  }
  const mode = getOptionalStringFlag(flags, 'mode') ?? 'diff'
  if (mode === 'edit' || mode === 'diff' || mode === 'both') {
    return mode
  }
  throw new RuntimeClientError('invalid_argument', 'Invalid --mode. Use edit, diff, or both.')
}

function canOpenEntryForEdit(entry: GitStatusEntry): string | null {
  if (entry.status === 'deleted') {
    return 'deleted file has no edit target'
  }
  if (entry.conflictStatus === 'unresolved') {
    return 'unresolved conflict may not have a single editable file'
  }
  return null
}

async function openFileEdit(
  ctx: HandlerContext,
  worktree: string,
  path: string
): Promise<FileOpenRecord> {
  const result = await ctx.client.call<RuntimeFileOpenResult>('files.open', {
    worktree,
    relativePath: path
  })
  return {
    path,
    mode: 'edit',
    opened: result.result.opened,
    kind: result.result.kind,
    ...(result.result.opened ? {} : { skipped: true, reason: `${result.result.kind} file` })
  }
}

async function openFileDiff(
  ctx: HandlerContext,
  worktree: string,
  path: string,
  staged: boolean
): Promise<FileOpenRecord> {
  const result = await ctx.client.call<RuntimeFileOpenResult>('files.openDiff', {
    worktree,
    relativePath: path,
    staged
  })
  return {
    path,
    mode: 'diff',
    staged,
    opened: result.result.opened,
    kind: result.result.kind,
    ...(result.result.opened ? {} : { skipped: true, reason: `${result.result.kind} file` })
  }
}

function formatOpenChangedResult(result: FileOpenChangedResult): string {
  if (result.totalChanged === 0) {
    return 'No changed files.'
  }
  const lines = [`Opened ${result.opened.length} changed file targets.`]
  if (result.skipped.length > 0) {
    lines.push(`Skipped ${result.skipped.length} changed file targets:`)
    for (const skipped of result.skipped) {
      lines.push(`- ${skipped.path}: ${skipped.reason ?? 'not opened'}`)
    }
  }
  return lines.join('\n')
}

function formatFileOpen(result: RuntimeFileOpenResult): string {
  return result.opened
    ? `Opened ${result.relativePath}.`
    : `Did not open ${result.relativePath}: ${result.kind} file.`
}

function formatFileDiff(result: RuntimeFileOpenResult): string {
  return result.opened
    ? `Opened diff for ${result.relativePath}.`
    : `Did not open diff for ${result.relativePath}: ${result.kind} file.`
}

export const FILE_HANDLERS: Record<string, CommandHandler> = {
  'file open': async (ctx) => {
    const path = getRequiredStringFlag(ctx.flags, 'path')
    const worktree = await getFileWorktreeSelector(ctx)
    const relativePath = await resolveFilePath(ctx, worktree, path)
    const result = await ctx.client.call<RuntimeFileOpenResult>('files.open', {
      worktree,
      relativePath
    })
    printResult(result, ctx.json, formatFileOpen)
  },
  'file diff': async (ctx) => {
    const path = getRequiredStringFlag(ctx.flags, 'path')
    const staged = ctx.flags.get('staged') === true
    const worktree = await getFileWorktreeSelector(ctx)
    const relativePath = await resolveFilePath(ctx, worktree, path)
    const result = await ctx.client.call<RuntimeFileOpenResult>('files.openDiff', {
      worktree,
      relativePath,
      staged
    })
    printResult(result, ctx.json, formatFileDiff)
  },
  'file open-changed': async (ctx) => {
    const mode = getOpenChangedMode(ctx.flags)
    const worktree = await getFileWorktreeSelector(ctx)
    const status = await ctx.client.call<GitStatusResult>('git.status', { worktree })
    const opened: FileOpenRecord[] = []
    const skipped: FileOpenRecord[] = []
    const openedEditPaths = new Set<string>()

    for (const entry of status.result.entries) {
      if (mode === 'edit' || mode === 'both') {
        const editSkipReason = canOpenEntryForEdit(entry)
        if (editSkipReason) {
          skipped.push({
            path: entry.path,
            mode: 'edit',
            opened: false,
            skipped: true,
            reason: editSkipReason
          })
        } else if (!openedEditPaths.has(entry.path)) {
          openedEditPaths.add(entry.path)
          const record = await openFileEdit(ctx, worktree, entry.path)
          const records = record.opened ? opened : skipped
          records.push(record)
        }
      }

      if (mode === 'diff' || mode === 'both') {
        const staged = entry.area === 'staged'
        if (entry.conflictStatus === 'unresolved') {
          skipped.push({
            path: entry.path,
            mode: 'diff',
            staged,
            opened: false,
            skipped: true,
            reason: 'unresolved conflict may not have a single diff target'
          })
        } else {
          const record = await openFileDiff(ctx, worktree, entry.path, staged)
          const records = record.opened ? opened : skipped
          records.push(record)
        }
      }
    }

    printResult(
      {
        ...status,
        result: {
          worktree,
          mode,
          opened,
          skipped,
          totalChanged: status.result.entries.length
        }
      },
      ctx.json,
      formatOpenChangedResult
    )
  }
}
