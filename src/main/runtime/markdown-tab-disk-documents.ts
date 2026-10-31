/** Mobile reads/saves host disk, never unsaved desktop text; isDirty reports desktop divergence. */
import {
  hashMarkdownContent,
  isMarkdownContentByteLengthOverLimit,
  MOBILE_MARKDOWN_EDIT_MAX_BYTES,
  MOBILE_MARKDOWN_READ_MAX_BYTES,
  truncateMobileMarkdownRead,
  utf8ByteLength,
  type RuntimeMarkdownReadTabResult,
  type RuntimeMarkdownSaveTabResult
} from '../../shared/mobile-markdown-document'
import type { RuntimeMobileSessionMarkdownTab } from '../../shared/runtime-types'
import type {
  FileWriteDiskPrecondition,
  FileWriteResult
} from '../../shared/file-write-disk-precondition'
import { getDiskBaselineSignature } from '../../shared/disk-baseline-signature'
import type {
  PersistedOpenFile,
  WorkspaceSessionState
} from '../../shared/workspace-session-state-types'
import { findListedEditorFile } from './mobile-session-editor-projection'

export type MarkdownDiskFile = { content: string; byteLength: number }

type MarkdownFileAddress = Pick<
  PersistedOpenFile,
  'filePath' | 'relativePath' | 'externalSshTargetId'
>

export type MarkdownTabDiskHost = Pick<MarkdownFileIo, 'readFile'> & {
  getWorkspaceSessionForWorktree(worktreeId: string): WorkspaceSessionState | null | undefined
  forSave(worktreeId: string, file: MarkdownFileAddress): Promise<MarkdownFileIo>
}

export type MarkdownFileIo = {
  /** Decode at most maxBytes (hosts may return less); report full size and reject binary_file. */
  readFile(
    worktreeId: string,
    file: MarkdownFileAddress,
    maxBytes: number
  ): Promise<MarkdownDiskFile>
  writeFileIfUnchanged(
    worktreeId: string,
    file: MarkdownFileAddress,
    content: string,
    precondition: FileWriteDiskPrecondition
  ): Promise<FileWriteResult>
}

export type ListedMarkdownTab = Pick<
  RuntimeMobileSessionMarkdownTab,
  'id' | 'mode' | 'filePath' | 'sourceFilePath' | 'sourceRelativePath' | 'isDirty' | 'isUntitled'
>

// Allow a capped multibyte character to decode whole before cutting.
const READ_SLACK_BYTES = 4

const saveQueues = new Map<string, Promise<unknown>>()

function savedEditorFile(
  host: MarkdownTabDiskHost,
  worktreeId: string,
  tab: ListedMarkdownTab
): PersistedOpenFile {
  const session = host.getWorkspaceSessionForWorktree(worktreeId)
  const files = session?.openFilesByWorktree?.[worktreeId] ?? []
  const sourceFilePath = tab.sourceFilePath || tab.filePath
  const file = session
    ? findListedEditorFile(files, session, worktreeId, { id: tab.id, filePath: sourceFilePath })
    : undefined
  if (!file && tab.mode === 'markdown-preview') {
    // Previews may outlive source tabs; only edit tabs persist, so orphaned previews stay read-only.
    return {
      filePath: sourceFilePath,
      relativePath: tab.sourceRelativePath,
      worktreeId,
      language: 'markdown'
    }
  }
  if (!file || (file.language !== 'markdown' && tab.mode !== 'markdown-preview')) {
    throw new Error('tab_not_found')
  }
  return file
}

function tabReadOnlyReason(
  tab: ListedMarkdownTab,
  file: PersistedOpenFile
): RuntimeMarkdownReadTabResult['readOnlyReason'] {
  if (tab.mode === 'markdown-preview') {
    return 'unsupported_preview'
  }
  // Mobile saves cannot turn unnamed desktop documents into files.
  if (tab.isUntitled) {
    return 'unsupported_untitled'
  }
  return file.readOnly ? 'unsupported_tab' : undefined
}

function readOnlyReason(
  tab: ListedMarkdownTab,
  file: PersistedOpenFile,
  byteLength: number
): RuntimeMarkdownReadTabResult['readOnlyReason'] {
  return (
    tabReadOnlyReason(tab, file) ??
    (byteLength > MOBILE_MARKDOWN_EDIT_MAX_BYTES ? 'file_too_large' : undefined)
  )
}

export async function readMarkdownTabFromDisk(
  host: MarkdownTabDiskHost,
  worktreeId: string,
  tab: ListedMarkdownTab
): Promise<RuntimeMarkdownReadTabResult> {
  const file = savedEditorFile(host, worktreeId, tab)
  const disk = await host.readFile(
    worktreeId,
    file,
    MOBILE_MARKDOWN_READ_MAX_BYTES + READ_SLACK_BYTES
  )
  const preview = truncateMobileMarkdownRead(disk.content)
  const reason = readOnlyReason(tab, file, disk.byteLength)
  return {
    tabId: tab.id,
    filePath: file.filePath,
    relativePath: file.relativePath,
    content: preview.content,
    isDirty: tab.isDirty,
    version: hashMarkdownContent(preview.content),
    source: 'file',
    editable: reason === undefined,
    ...(reason ? { readOnlyReason: reason } : {}),
    ...(disk.byteLength > utf8ByteLength(preview.content)
      ? { truncated: true, byteLength: disk.byteLength }
      : {})
  }
}

export async function saveMarkdownTabToDisk(
  host: MarkdownTabDiskHost,
  worktreeId: string,
  tab: ListedMarkdownTab,
  baseVersion: string,
  content: string
): Promise<RuntimeMarkdownSaveTabResult> {
  if (isMarkdownContentByteLengthOverLimit(content, MOBILE_MARKDOWN_EDIT_MAX_BYTES)) {
    throw new Error('file_too_large')
  }
  const key = `${worktreeId}\0${savedEditorFile(host, worktreeId, tab).filePath}`
  const previous = saveQueues.get(key) ?? Promise.resolve()
  const save = previous
    .catch(() => undefined)
    .then(() => saveOnce(host, worktreeId, tab, baseVersion, content))
  saveQueues.set(key, save)
  try {
    return await save
  } finally {
    if (saveQueues.get(key) === save) {
      saveQueues.delete(key)
    }
  }
}

async function saveOnce(
  host: MarkdownTabDiskHost,
  worktreeId: string,
  tab: ListedMarkdownTab,
  baseVersion: string,
  content: string
): Promise<RuntimeMarkdownSaveTabResult> {
  const file = savedEditorFile(host, worktreeId, tab)
  const refusal = tabReadOnlyReason(tab, file)
  if (refusal) {
    throw new Error(refusal)
  }
  const io = await host.forSave(worktreeId, file)
  const disk = await io.readFile(worktreeId, file, MOBILE_MARKDOWN_EDIT_MAX_BYTES + 1)
  const reason = readOnlyReason(tab, file, disk.byteLength)
  if (reason) {
    throw new Error(reason)
  }
  const saved = { tabId: tab.id, isDirty: false as const, version: hashMarkdownContent(content) }
  if (hashMarkdownContent(disk.content) !== baseVersion) {
    // A repeated save already on disk succeeds rather than conflicting.
    if (disk.content === content) {
      return { ...saved, content }
    }
    throw new Error('conflict')
  }
  const written = await io.writeFileIfUnchanged(worktreeId, file, content, {
    expectedSignature: getDiskBaselineSignature(disk.content)
  })
  if (!written.ok) {
    throw new Error('conflict')
  }
  return { ...saved, content }
}
