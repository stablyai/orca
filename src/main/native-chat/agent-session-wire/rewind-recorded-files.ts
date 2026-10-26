import {
  writeFileAtomicallyIfUnchanged,
  removeFileAtomicallyIfUnchanged
} from '../../codex-accounts/fs-utils'
import { constants } from 'node:fs'
import { createHash } from 'node:crypto'
import { lstat, realpath, open } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { applyPatch, parsePatch, reversePatch, type StructuredPatch } from 'diff'
import type { RewindFilePlan } from '../../../shared/agent-session-rewind-files'
import type { AgentJournalRenderItem } from '../../../shared/agent-session-journal-types'

const MAX_BYTES = 4 * 1024 * 1024

function fail(reason: string): never {
  throw new Error(`File recovery unavailable: ${reason}`)
}

async function checkedPath(root: string, name: string): Promise<string> {
  const path = resolve(root, name)
  const local = relative(root, path)
  if (
    !local ||
    isAbsolute(local) ||
    local.split(sep).some((part) => part === '..' || part.toLowerCase() === '.git')
  ) {
    fail(`path outside the workspace: ${name}`)
  }
  let parent = dirname(path)
  while (parent !== root) {
    if ((await lstat(parent)).isSymbolicLink()) {
      fail(`symbolic link: ${name}`)
    }
    parent = dirname(parent)
  }
  return path
}

async function readText(path: string): Promise<{ text: string | null; mode: number }> {
  let stat
  try {
    stat = await lstat(path)
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return { text: null, mode: 0o644 }
    }
    throw error
  }
  if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_BYTES) {
    fail(`unsupported file: ${path}`)
  }
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  let bytes: Buffer
  try {
    const opened = await handle.stat()
    if (
      !opened.isFile() ||
      opened.nlink !== 1 ||
      opened.ino !== stat.ino ||
      opened.dev !== stat.dev ||
      opened.size > MAX_BYTES
    ) {
      fail(`file changed while reading: ${path}`)
    }
    bytes = await handle.readFile()
  } finally {
    await handle.close()
  }
  const text = bytes.toString('utf8')
  if (bytes.length > MAX_BYTES || text.includes('\0') || !Buffer.from(text).equals(bytes)) {
    fail(`binary or oversized file: ${path}`)
  }
  return { text, mode: stat.mode & 0o777 }
}

function pathOf(patch: StructuredPatch): string {
  const old = patch.oldFileName
  const next = patch.newFileName
  const name = next === '/dev/null' ? old : next
  if (
    !name ||
    (old !== '/dev/null' &&
      next !== '/dev/null' &&
      old?.replace(/^a\//, '') !== next?.replace(/^b\//, ''))
  ) {
    fail('renamed files need a complete recovery record')
  }
  return name.replace(/^[ab]\//, '')
}

function reverseExactly(text: string | null, patch: StructuredPatch): string | null {
  if ((patch.newFileName === '/dev/null') !== (text === null)) {
    fail(`file existence changed: ${pathOf(patch)}`)
  }
  const reversed = reversePatch(patch)
  const lines = (text ?? '').split('\n')
  for (const hunk of reversed.hunks) {
    const expected = hunk.lines
      .filter((line) => line[0] === ' ' || line[0] === '-')
      .map((line) => line.slice(1))
    const start = hunk.oldLines === 0 ? hunk.oldStart : hunk.oldStart - 1
    if (expected.some((line, index) => lines[start + index] !== line)) {
      fail(`later edits conflict with ${pathOf(patch)}`)
    }
  }
  const result = applyPatch(text ?? '', reversed, { fuzzFactor: 0, autoConvertLineEndings: false })
  if (result === false) {
    fail(`later edits conflict with ${pathOf(patch)}`)
  }
  if (patch.oldFileName === '/dev/null') {
    if (result !== '') {
      fail(`new file has additional content: ${pathOf(patch)}`)
    }
    return null
  }
  return result
}

/** Only complete, attributed edits can authorize writes; transcript prose never does. */
export async function prepareRecordedFileRewind(
  workspace: string,
  discarded: readonly AgentJournalRenderItem[]
): Promise<RewindFilePlan> {
  const root = await realpath(workspace)
  const files = new Map<string, RewindFilePlan['files'][number]>()
  let bytes = 0
  for (const item of discarded.toReversed()) {
    const body = item.body
    if (body.kind === 'tool-call') {
      fail('this history includes tool changes without complete file recovery records')
    }
    if (body.kind !== 'diff') {
      if (
        !['message', 'status', 'turn', 'approval', 'question'].includes(body.kind) ||
        (body.kind === 'status' && 'providerFrame' in body && body.providerFrame)
      ) {
        fail('this history includes an unrecognized provider operation')
      }
      continue
    }
    if (body.state !== 'completed') {
      fail('file edit completion was not recorded')
    }
    if (body.patch.truncated) {
      fail('the recorded patch is truncated')
    }
    if (/^(?:rename from |rename to |Moved to:)/m.test(body.patch.head)) {
      fail('renamed files need a complete recovery record')
    }
    const patches = parsePatch(body.patch.head)
    if (!patches.length || patches.some((patch) => !patch.hunks.length)) {
      fail('no complete patch was recorded')
    }
    for (const patch of patches.toReversed()) {
      if (patch.oldFileName !== '/dev/null' && patch.hunks.every((hunk) => hunk.oldLines === 0)) {
        fail('file creation was not recorded unambiguously')
      }
      const path = await checkedPath(root, pathOf(patch))
      let file = files.get(path)
      if (file && patch.newFileName === '/dev/null') {
        fail('multiple creation and deletion records need full file snapshots')
      }
      if (!file) {
        if (files.size >= 100) {
          fail('too many files')
        }
        const current = await readText(path)
        if ((await readText(`${path}.orca-guarded`)).text !== null) {
          fail(`an existing recovery file needs attention: ${path}`)
        }
        let mode = current.mode
        if (patch.newFileName === '/dev/null') {
          const recordedMode = /^deleted file mode (100644|100755)$/m.exec(body.patch.head)
          if (patches.length !== 1 || !recordedMode) {
            fail('the deleted file permissions were not recorded')
          }
          mode = Number.parseInt(recordedMode[1]!.slice(-3), 8)
        }
        file = { path, before: current.text, after: current.text, mode }
        files.set(path, file)
        bytes += Buffer.byteLength(current.text ?? '')
      }
      file.after = reverseExactly(file.after, patch)
      bytes += Buffer.byteLength(body.patch.head)
      if (bytes > MAX_BYTES) {
        fail('recovery data is too large')
      }
    }
  }
  if (!files.size) {
    fail('no complete file edits were recorded after this message')
  }
  return { root, files: [...files.values()] }
}

export function rewindFilePlanFingerprint(plan: RewindFilePlan): string {
  return createHash('sha256').update(JSON.stringify(plan)).digest('hex')
}

/** Replayed after a crash: a file already at its target is settled, never reversed twice. */
export async function applyRecordedFileRewind(
  plan: RewindFilePlan,
  recovery = false
): Promise<void> {
  if ((await realpath(plan.root)) !== plan.root) {
    fail('workspace moved')
  }
  const pending: RewindFilePlan['files'] = []
  for (const file of plan.files) {
    const path = await checkedPath(plan.root, file.path)
    const current = await readText(path)
    const held = await readText(`${path}.orca-guarded`)
    if (
      held.text !== null &&
      (!recovery || (held.text !== file.before && held.text !== file.after))
    ) {
      fail(`an unexpected recovery file exists: ${relative(plan.root, path)}`)
    }
    if (current.text === file.after && held.text === null) {
      continue
    }
    const effective = current.text === null && held.text !== null ? held : current
    if (
      (effective.text !== file.before && effective.text !== file.after) ||
      (effective.text !== null && effective.mode !== file.mode)
    ) {
      fail(`file changed since confirmation: ${relative(plan.root, path)}`)
    }
    pending.push(file)
  }
  for (const file of pending) {
    const path = await checkedPath(plan.root, file.path)
    const current = await readText(path)
    const held = await readText(`${path}.orca-guarded`)
    if (
      held.text !== null &&
      (!recovery || (held.text !== file.before && held.text !== file.after))
    ) {
      fail(`an unexpected recovery file exists: ${path}`)
    }
    const expected = current.text ?? held.text
    if (expected !== file.before && expected !== file.after) {
      fail(`concurrent edit: ${relative(plan.root, path)}`)
    }
    const changed =
      file.after === null
        ? expected !== null && removeFileAtomicallyIfUnchanged(path, expected)
        : writeFileAtomicallyIfUnchanged(path, expected, file.after, { mode: file.mode })
    if (!changed) {
      fail(`concurrent edit: ${relative(plan.root, path)}`)
    }
  }
}

export function undoRecordedFileRewind(plan: RewindFilePlan): Promise<void> {
  return applyRecordedFileRewind(
    {
      ...plan,
      files: plan.files.map((file) => ({ ...file, before: file.after, after: file.before }))
    },
    true
  )
}
