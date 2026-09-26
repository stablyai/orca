import { rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { PerforceEntry, PerforceOperationResult } from '../../shared/perforce-types'
import { escapeP4FileArg, runP4, runP4OrThrow } from './p4-command'

function toResult(result: {
  code: number | null
  stdout: string
  stderr: string
}): PerforceOperationResult {
  const output = [result.stdout, result.stderr]
    .filter((text) => text.trim())
    .join('\n')
    .trim()
  return result.code === 0
    ? { success: true, output }
    : { success: false, output, error: result.stderr.trim() || output || 'p4 command failed' }
}

function fileArgs(filePaths: readonly string[]): string[] {
  return filePaths.map(escapeP4FileArg)
}

/** Opens files for add/edit/delete as their on-disk state dictates. */
export async function reconcileFiles(
  cwd: string,
  filePaths: readonly string[],
  changelist?: number
): Promise<PerforceOperationResult> {
  const cl = changelist ? ['-c', String(changelist)] : []
  return toResult(await runP4(['reconcile', ...cl, ...fileArgs(filePaths)], { cwd }))
}

/** Checks files out for edit (used before writing a read-only workspace file). */
export async function editFiles(
  cwd: string,
  filePaths: readonly string[]
): Promise<PerforceOperationResult> {
  return toResult(await runP4(['edit', ...fileArgs(filePaths)], { cwd }))
}

/** Closes files without touching their content on disk. */
export async function closeFilesKeepingContent(
  cwd: string,
  filePaths: readonly string[]
): Promise<PerforceOperationResult> {
  return toResult(await runP4(['revert', '-k', ...fileArgs(filePaths)], { cwd }))
}

/** Discards local changes: reverts opened files, resyncs modified ones, deletes new ones. */
export async function discardFiles(
  cwd: string,
  entries: readonly Pick<PerforceEntry, 'path' | 'group' | 'action'>[]
): Promise<PerforceOperationResult> {
  const outputs: string[] = []
  const opened = entries.filter((entry) => entry.group === 'opened')
  const modified = entries.filter((entry) => entry.group === 'modified')
  const fresh = entries.filter((entry) => entry.group === 'new')
  if (opened.length > 0) {
    const result = toResult(
      await runP4(['revert', ...fileArgs(opened.map((e) => e.path))], { cwd })
    )
    if (!result.success) {
      return result
    }
    outputs.push(result.output)
    // Why: reverting an add leaves the file behind; a discard should remove it.
    for (const entry of opened.filter((e) => e.action === 'add' || e.action === 'branch')) {
      await rm(resolve(cwd, entry.path), { force: true })
    }
  }
  if (modified.length > 0) {
    const targets = fileArgs(modified.map((e) => `${e.path}`)).map((arg) => `${arg}#have`)
    const result = toResult(await runP4(['sync', '-f', ...targets], { cwd }))
    if (!result.success) {
      return result
    }
    outputs.push(result.output)
  }
  for (const entry of fresh) {
    await rm(resolve(cwd, entry.path), { force: true })
  }
  return { success: true, output: outputs.filter(Boolean).join('\n') }
}

export async function submitDefaultChangelist(
  cwd: string,
  description: string
): Promise<PerforceOperationResult> {
  return toResult(await runP4(['submit', '-d', description], { cwd, timeoutMs: 600_000 }))
}

export async function submitChangelist(
  cwd: string,
  changelist: number
): Promise<PerforceOperationResult> {
  return toResult(await runP4(['submit', '-c', String(changelist)], { cwd, timeoutMs: 600_000 }))
}

export async function syncLatest(cwd: string): Promise<PerforceOperationResult> {
  return toResult(await runP4(['sync'], { cwd, timeoutMs: 1_800_000 }))
}

export async function shelveChangelist(
  cwd: string,
  changelist: number
): Promise<PerforceOperationResult> {
  return toResult(await runP4(['shelve', '-f', '-c', String(changelist)], { cwd }))
}

export function buildChangeSpec(template: string, description: string): string {
  const indented = description
    .trim()
    .split(/\r?\n/)
    .map((line) => `\t${line}`)
    .join('\n')
  const lines = template.split(/\r?\n/)
  const out: string[] = []
  let skipping = false
  for (const line of lines) {
    if (/^\S/.test(line)) {
      skipping = false
    }
    if (line.startsWith('Description:')) {
      out.push('Description:', indented)
      skipping = true
    } else if (line.startsWith('Files:')) {
      // Files move via `reopen`, so a new changelist starts empty.
      skipping = true
    } else if (!skipping) {
      out.push(line)
    }
  }
  return `${out.join('\n')}\n`
}

/** Creates a numbered changelist and moves the given files into it. */
export async function createChangelistWithFiles(
  cwd: string,
  description: string,
  filePaths: readonly string[]
): Promise<PerforceOperationResult & { changelist?: number }> {
  const template = await runP4OrThrow(['change', '-o'], { cwd })
  const created = await runP4(['change', '-i'], {
    cwd,
    input: buildChangeSpec(template, description)
  })
  const match = /Change (\d+) created/.exec(created.stdout)
  if (created.code !== 0 || !match) {
    return toResult(created)
  }
  const changelist = Number(match[1])
  if (filePaths.length > 0) {
    const moved = await moveFilesToChangelist(cwd, filePaths, changelist)
    if (!moved.success) {
      return { ...moved, changelist }
    }
  }
  return { success: true, output: created.stdout.trim(), changelist }
}

export async function moveFilesToChangelist(
  cwd: string,
  filePaths: readonly string[],
  changelist: number | 'default'
): Promise<PerforceOperationResult> {
  return toResult(
    await runP4(['reopen', '-c', String(changelist), ...fileArgs(filePaths)], { cwd })
  )
}

export async function deleteEmptyChangelist(
  cwd: string,
  changelist: number
): Promise<PerforceOperationResult> {
  return toResult(await runP4(['change', '-d', String(changelist)], { cwd }))
}
