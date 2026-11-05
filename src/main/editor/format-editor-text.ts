import { runProcess } from '@orca/process-host'
import { basename, dirname, join, matchesGlob, relative } from 'node:path'
import { lstat, realpath } from 'node:fs/promises'
import {
  editorFormatterArgv,
  editorFormatterSchema,
  type EditorFormatResult
} from '../../shared/editor-formatter'
import { getRepoExecutionHostId } from '../../shared/execution-host'
import { isPathInsideOrEqual } from '../../shared/cross-platform-path'
import type { RuntimeStore } from '../runtime/runtime-store-contract'
import type { RuntimeFileExplorerPath } from '../runtime/files/file-target'
import { isENOENT } from '../ipc/filesystem/access/filesystem-path-containment'

async function formatterFilePath(filePath: string): Promise<string> {
  try {
    return await realpath(filePath)
  } catch (error) {
    if (!isENOENT(error)) {
      throw error
    }
    const entry = await lstat(filePath).catch((reason: unknown) => {
      if (!isENOENT(reason)) {
        throw reason
      }
      return null
    })
    if (entry?.isSymbolicLink()) {
      throw new Error('Cannot format a dangling file link.')
    }
    return join(await realpath(dirname(filePath)), basename(filePath))
  }
}

export async function formatEditorText(
  store: Pick<RuntimeStore, 'getRepos'>,
  target: Pick<RuntimeFileExplorerPath, 'path' | 'executionHostId'> & {
    worktree: Pick<RuntimeFileExplorerPath['worktree'], 'path' | 'repoId'>
  },
  text: string,
  // Why: runs only once a formatter applies, so unconfigured or excluded
  // files on hosts that cannot run formatters still save silently.
  assertCanRunFormatter: () => void = () => {}
): Promise<EditorFormatResult> {
  const repo = store
    .getRepos()
    .find(
      (row) =>
        row.id === target.worktree.repoId && getRepoExecutionHostId(row) === target.executionHostId
    )
  if (!repo?.editorFormatter?.command.trim()) {
    return { kind: 'skipped' }
  }
  const config = editorFormatterSchema.parse(repo.editorFormatter)
  const relativePath = relative(target.worktree.path, target.path).replace(/\\/g, '/')
  if (
    !isPathInsideOrEqual(target.worktree.path, target.path) ||
    !config.include.some((glob) => matchesGlob(relativePath, glob))
  ) {
    return { kind: 'skipped' }
  }
  assertCanRunFormatter()
  const [root, filePath] = await Promise.all([
    realpath(target.worktree.path),
    formatterFilePath(target.path)
  ])
  if (!isPathInsideOrEqual(root, filePath)) {
    throw new Error('Cannot format a file linked outside its workspace.')
  }
  const [program, ...args] = editorFormatterArgv(
    config.command,
    target.path,
    relativePath,
    process.platform
  )
  const result = await runProcess({
    program,
    args,
    cwd: target.worktree.path,
    input: text,
    timeoutMs: 10_000,
    maxOutputBytes: 512 * 1024,
    killOnOutputLimit: true,
    detached: process.platform !== 'win32',
    terminationBarrier: true
  })
  if (result.timedOut) {
    throw new Error('Formatter timed out after 10 seconds.')
  }
  if (result.outputTruncated) {
    throw new Error('Formatter output exceeded the 512 KB limit.')
  }
  if (result.code !== 0) {
    throw new Error(result.stderr.trim().slice(0, 2000) || `Formatter exited with ${result.code}.`)
  }
  if (text.trim() && !result.stdout.trim()) {
    throw new Error('Formatter returned no text for a non-empty buffer.')
  }
  return { kind: 'formatted', text: result.stdout }
}
