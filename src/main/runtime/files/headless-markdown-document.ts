import { isBinaryBuffer } from '../../../shared/binary-buffer'
import { getDiskBaselineSignature } from '../../../shared/disk-baseline-signature'
import {
  hashMarkdownContent,
  isMarkdownContentByteLengthOverLimit,
  MOBILE_MARKDOWN_EDIT_MAX_BYTES,
  MOBILE_MARKDOWN_READ_MAX_BYTES,
  truncateMobileMarkdownRead,
  type RuntimeMarkdownReadTabResult,
  type RuntimeMarkdownSaveTabResult
} from '../../../shared/mobile-markdown-document'
import type {
  PersistedOpenFile,
  WorkspaceSessionState
} from '../../../shared/workspace-session-state-types'
import { runKeyedSerializedOperation } from '../../cli/keyed-promise-queue'
import {
  openLocalRegularFile,
  readLocalFilePrefix
} from '../../ipc/filesystem/local-regular-file-read'
import { buildHeadlessMobileSessionEditorTabs } from '../mobile-session-editor-projection'
import { resolveRuntimeAuthorizedPath } from './chat-scratch-file-root'
import { requireRuntimeFileProvider } from './file-target'
import type { RuntimeFileCommandHost } from './file-command-host'

type Host = Pick<RuntimeFileCommandHost, 'requireStore' | 'resolveRuntimeFileTarget'> & {
  getSession(worktreeId: string): WorkspaceSessionState | null | undefined
  updateSession(
    worktreeId: string,
    update: (session: WorkspaceSessionState) => WorkspaceSessionState
  ): void
}

export class HeadlessMarkdownDocuments {
  private readonly saves = new Map<string, Promise<void>>()

  constructor(private readonly host: Host) {}

  private target(worktreeId: string, tabId: string): PersistedOpenFile {
    const session = this.host.getSession(worktreeId)
    const tab =
      session &&
      buildHeadlessMobileSessionEditorTabs(worktreeId, session).find(
        (candidate) => candidate.id === tabId && candidate.type === 'markdown'
      )
    const file =
      tab &&
      session.openFilesByWorktree?.[worktreeId]?.find(
        (candidate) =>
          candidate.filePath === tab.filePath &&
          !candidate.runtimeEnvironmentId &&
          !candidate.externalSshTargetId
      )
    if (!file) {
      throw new Error('tab_not_found')
    }
    return file
  }

  private async disk(worktreeId: string, file: PersistedOpenFile) {
    const target = await this.host.resolveRuntimeFileTarget(worktreeId)
    const provider = requireRuntimeFileProvider(target, this.host)
    const path = await resolveRuntimeAuthorizedPath(file.filePath, this.host.requireStore())
    const { handle, stats } = await openLocalRegularFile(path)
    try {
      const bytes = await readLocalFilePrefix(
        handle,
        Math.min(stats.size, MOBILE_MARKDOWN_READ_MAX_BYTES + 4)
      )
      if (isBinaryBuffer(bytes)) {
        throw new Error('binary_file')
      }
      return { content: bytes.toString('utf8'), byteLength: stats.size, provider }
    } finally {
      await handle.close()
    }
  }

  async read(worktreeId: string, tabId: string): Promise<RuntimeMarkdownReadTabResult> {
    const file = this.target(worktreeId, tabId)
    const disk = file.dirtyDraftContent === undefined ? await this.disk(worktreeId, file) : null
    const content = file.dirtyDraftContent ?? disk?.content ?? ''
    const preview = truncateMobileMarkdownRead(content)
    const tooLarge = isMarkdownContentByteLengthOverLimit(content, MOBILE_MARKDOWN_EDIT_MAX_BYTES)
    const readOnlyReason = file.readOnly
      ? 'unsupported_tab'
      : tooLarge
        ? 'file_too_large'
        : undefined
    return {
      tabId,
      filePath: file.filePath,
      relativePath: file.relativePath,
      content: preview.content,
      version: hashMarkdownContent(preview.content),
      isDirty: file.dirtyDraftContent !== undefined,
      source: file.dirtyDraftContent === undefined ? 'file' : 'draft',
      editable: !readOnlyReason,
      ...(readOnlyReason ? { readOnlyReason } : {}),
      ...(preview.truncated
        ? { truncated: true, byteLength: disk?.byteLength ?? preview.byteLength }
        : {})
    }
  }

  async save(
    worktreeId: string,
    tabId: string,
    baseVersion: string,
    content: string
  ): Promise<RuntimeMarkdownSaveTabResult> {
    const file = this.target(worktreeId, tabId)
    const key = `${worktreeId}:${file.filePath}`
    return runKeyedSerializedOperation(this.saves, key, async () => {
      const current = this.target(worktreeId, tabId)
      if (current.readOnly) {
        throw new Error('unsupported_tab')
      }
      if (isMarkdownContentByteLengthOverLimit(content, MOBILE_MARKDOWN_EDIT_MAX_BYTES)) {
        throw new Error('file_too_large')
      }
      const disk = await this.disk(worktreeId, current)
      const baseline = current.dirtyDraftContent ?? disk.content
      if (isMarkdownContentByteLengthOverLimit(baseline, MOBILE_MARKDOWN_EDIT_MAX_BYTES)) {
        throw new Error('file_too_large')
      }
      if (hashMarkdownContent(baseline) !== baseVersion && baseline !== content) {
        throw new Error('conflict')
      }
      const expectedSignature =
        current.dirtyDraftContent !== undefined
          ? current.lastKnownDiskSignature
          : getDiskBaselineSignature(disk.content)
      // A restored draft without its disk baseline cannot safely replace external edits.
      if (!expectedSignature) {
        throw new Error('conflict')
      }
      const written = await disk.provider.writeFileWithDiskPrecondition(current.filePath, content, {
        expectedSignature
      })
      if (!written.ok) {
        throw new Error('conflict')
      }
      const verified = await this.disk(worktreeId, current)
      if (verified.content !== content) {
        throw new Error('save_verification_failed')
      }
      this.host.updateSession(worktreeId, (session) => ({
        ...session,
        openFilesByWorktree: {
          ...session.openFilesByWorktree,
          [worktreeId]: (session.openFilesByWorktree?.[worktreeId] ?? []).map((candidate) => {
            if (
              candidate.filePath !== current.filePath ||
              candidate.runtimeEnvironmentId ||
              candidate.externalSshTargetId ||
              candidate.dirtyDraftContent !== current.dirtyDraftContent
            ) {
              return candidate
            }
            const { dirtyDraftContent: _draft, ...saved } = candidate
            return { ...saved, lastKnownDiskSignature: getDiskBaselineSignature(content) }
          })
        }
      }))
      return { tabId, version: hashMarkdownContent(content), isDirty: false as const, content }
    })
  }
}
