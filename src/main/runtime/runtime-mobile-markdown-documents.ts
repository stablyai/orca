import { getSshTargetIdForExecutionHost, type ExecutionHostId } from '../../shared/execution-host'
import { normalizeRuntimePathForComparison } from '../../shared/cross-platform-path'
import {
  hashMarkdownContent,
  isMarkdownContentByteLengthOverLimit,
  MOBILE_MARKDOWN_EDIT_MAX_BYTES,
  resolveMobileMarkdownReadOnlyReason,
  type RuntimeMarkdownReadOnlyReason,
  type RuntimeMarkdownReadTabResult,
  type RuntimeMarkdownSaveTabResult
} from '../../shared/mobile-markdown-document'
import { isMobileSessionMarkdownEditorFile } from '../../shared/mobile-session-editor-tab-projection'
import { detectLanguage } from '../../shared/language-detect'
import type { Store } from '../persistence'
import {
  assertSshMutationExpectation,
  getSshConnectionGeneration
} from '../ssh/ssh-connection-generation'
import { assertHostEditorAuthority } from './editor-authority'
import { listHostEditTabs, type HostEditTabRecord } from './host-editor-session-model'
import type { HostEditorTabsRuntime } from './host-editor-tab-publication'
import { getHostEditorTabState } from './host-editor-tab-state'
import {
  readLocalMarkdownDocument,
  readSshMarkdownDocument,
  type MarkdownDocumentRead
} from './host-markdown-document-reader'
import { isHostEditRowInsideWorkspace } from './host-editor-tab-projection'
import {
  requireRuntimeFileProvider,
  type ResolvedRuntimeFileTarget
} from './runtime-file-command-target'
import { joinWorktreeRelativePath } from './runtime-relative-paths'

export type HostMarkdownRuntime = HostEditorTabsRuntime & {
  requireStore(): Store
  resolveRuntimeFileTarget(selector: string): Promise<ResolvedRuntimeFileTarget>
  getWorkspaceSessionHostIdForWorktree(worktreeId: string): ExecutionHostId
  writeHostMarkdownFile(args: {
    worktreeId: string
    relativePath: string
    content: string
    executionHostId: ExecutionHostId
    sshTargetId: string | undefined
    sshConnectionGeneration: number | undefined
    beforeWrite: () => void
  }): Promise<void>
}

type HostMarkdownTab = {
  record: HostEditTabRecord
  target: ResolvedRuntimeFileTarget
  /** The row's file joined onto this workspace's root; null for a row naming a file outside it. */
  filePath: string | null
  /** Why the document can never be edited from a phone, independent of its content. */
  fixedReadOnlyReason?: RuntimeMarkdownReadOnlyReason
}

type HostExpectations = {
  executionHostId: ExecutionHostId
  sshTargetId: string | undefined
  sshConnectionGeneration: number | undefined
}

function findHostMarkdownRecord(
  runtime: HostMarkdownRuntime,
  worktreeId: string,
  tabId: string
): HostEditTabRecord {
  const session = runtime.getOwnWorkspaceSessionForWorktree(worktreeId)
  const record = session
    ? listHostEditTabs(session, worktreeId).find(
        (candidate) => candidate.tabId === tabId || candidate.fileId === tabId
      )
    : undefined
  if (
    !record ||
    !isMobileSessionMarkdownEditorFile({
      mode: 'edit',
      language: detectLanguage(record.file.relativePath || record.file.filePath)
    })
  ) {
    throw new Error('tab_not_found')
  }
  return record
}

function captureHostExpectations(
  runtime: HostMarkdownRuntime,
  worktreeId: string
): HostExpectations {
  const executionHostId = runtime.getWorkspaceSessionHostIdForWorktree(worktreeId)
  const sshTargetId = getSshTargetIdForExecutionHost(executionHostId) ?? undefined
  return {
    executionHostId,
    sshTargetId,
    sshConnectionGeneration: sshTargetId ? getSshConnectionGeneration(sshTargetId) : undefined
  }
}

async function resolveHostMarkdownTab(
  runtime: HostMarkdownRuntime,
  worktreeId: string,
  tabId: string,
  expectations: HostExpectations
): Promise<HostMarkdownTab> {
  findHostMarkdownRecord(runtime, worktreeId, tabId)
  const target = await runtime.resolveRuntimeFileTarget(`id:${worktreeId}`)
  if (target.executionHostId !== expectations.executionHostId) {
    throw new Error('Workspace host changed; refresh and try again')
  }
  // Why re-read after the await: the tab may have closed or moved while the target resolved.
  const record = findHostMarkdownRecord(runtime, worktreeId, tabId)
  // Why: a row naming a file outside this workspace (or on another SSH target) is never re-joined
  // onto this root; such rows are not listed to phones, and a request naming one is refused.
  const outsideWorkspace = !isHostEditRowInsideWorkspace(record.file, target.worktree.path)
  const joined = outsideWorkspace
    ? null
    : joinWorktreeRelativePath(target.worktree.path, record.file.relativePath)
  const recordedHost =
    record.groupId !== null ? recordedWrapperHost(runtime, worktreeId, record) : null
  if (recordedHost && recordedHost !== target.executionHostId) {
    throw new Error('Workspace host changed; refresh and try again')
  }
  return {
    record,
    target,
    filePath: outsideWorkspace ? null : joined,
    ...(outsideWorkspace || record.file.readOnly === true
      ? { fixedReadOnlyReason: 'unsupported_tab' as const }
      : {})
  }
}

function recordedWrapperHost(
  runtime: HostMarkdownRuntime,
  worktreeId: string,
  record: HostEditTabRecord
): ExecutionHostId | null {
  const wrapper = runtime
    .getOwnWorkspaceSessionForWorktree(worktreeId)
    ?.unifiedTabs?.[worktreeId]?.find((tab) => tab.id === record.tabId)
  return wrapper?.executionHostId ?? null
}

async function readDocument(
  runtime: HostMarkdownRuntime,
  tab: HostMarkdownTab
): Promise<MarkdownDocumentRead> {
  // Why: a phone request may only reach files inside the workspace it names.
  if (!tab.filePath) {
    throw new Error('unsupported_tab')
  }
  const provider = requireRuntimeFileProvider(tab.target)
  return provider
    ? await readSshMarkdownDocument(tab.filePath, provider)
    : await readLocalMarkdownDocument(tab.filePath, runtime.requireStore())
}

function hasHostDraft(record: HostEditTabRecord): boolean {
  return record.file.readOnly !== true && record.file.dirtyDraftContent !== undefined
}

export async function readHostMarkdownTab(
  runtime: HostMarkdownRuntime,
  worktreeId: string,
  tabId: string
): Promise<RuntimeMarkdownReadTabResult> {
  const tab = await resolveHostMarkdownTab(
    runtime,
    worktreeId,
    tabId,
    captureHostExpectations(runtime, worktreeId)
  )
  const document = await readDocument(runtime, tab)
  const readOnlyReason =
    tab.fixedReadOnlyReason ??
    (document.truncated
      ? 'file_too_large'
      : resolveMobileMarkdownReadOnlyReason({ mode: 'edit', content: document.content }))
  // Why: a desktop draft the host cannot arbitrate is shown as stale disk content, never editable.
  const isDirty = hasHostDraft(tab.record)
  return {
    tabId,
    filePath: tab.record.file.filePath,
    relativePath: tab.record.file.relativePath,
    content: document.content,
    isDirty,
    version: hashMarkdownContent(document.content),
    source: 'file',
    editable: readOnlyReason === undefined && !isDirty,
    ...(readOnlyReason ? { readOnlyReason } : {}),
    ...(document.truncated ? { truncated: true, byteLength: document.byteLength } : {})
  }
}

function assertSaveStillOwned(
  runtime: HostMarkdownRuntime,
  worktreeId: string,
  tabId: string,
  filePath: string,
  expectations: HostExpectations
): HostEditTabRecord {
  assertHostEditorAuthority(runtime)
  const record = findHostMarkdownRecord(runtime, worktreeId, tabId)
  if (
    normalizeRuntimePathForComparison(record.file.filePath) !==
    normalizeRuntimePathForComparison(filePath)
  ) {
    throw new Error('tab_not_found')
  }
  if (hasHostDraft(record) || record.file.readOnly === true) {
    throw new Error('unsupported_tab')
  }
  if (runtime.getWorkspaceSessionHostIdForWorktree(worktreeId) !== expectations.executionHostId) {
    throw new Error('Workspace host changed; refresh and try again')
  }
  assertSshMutationExpectation(
    expectations.sshTargetId,
    expectations.sshTargetId,
    expectations.sshConnectionGeneration
  )
  return record
}

export async function saveHostMarkdownTab(
  runtime: HostMarkdownRuntime,
  worktreeId: string,
  tabId: string,
  baseVersion: string,
  content: string
): Promise<RuntimeMarkdownSaveTabResult> {
  if (isMarkdownContentByteLengthOverLimit(content, MOBILE_MARKDOWN_EDIT_MAX_BYTES)) {
    throw new Error('file_too_large')
  }
  // Why first: a stale save must fail against the host and generation it started on, never pass on a fresh one.
  const expectations = captureHostExpectations(runtime, worktreeId)
  const initial = await resolveHostMarkdownTab(runtime, worktreeId, tabId, expectations)
  if (initial.fixedReadOnlyReason) {
    throw new Error(initial.fixedReadOnlyReason)
  }
  const laneKey = `${expectations.executionHostId}\u0000${initial.filePath ?? ''}`
  return await getHostEditorTabState(runtime).runInSaveLane(laneKey, async () => {
    const tab = await resolveHostMarkdownTab(runtime, worktreeId, tabId, expectations)
    if (tab.fixedReadOnlyReason) {
      throw new Error(tab.fixedReadOnlyReason)
    }
    assertSaveStillOwned(runtime, worktreeId, tabId, tab.record.file.filePath, expectations)
    const current = await readDocument(runtime, tab)
    if (
      current.truncated ||
      isMarkdownContentByteLengthOverLimit(current.content, MOBILE_MARKDOWN_EDIT_MAX_BYTES)
    ) {
      throw new Error('file_too_large')
    }
    const currentVersion = hashMarkdownContent(current.content)
    if (currentVersion !== baseVersion) {
      if (current.content === content) {
        // Why: a duplicate save tap queued behind the first one finds its own text already there.
        return { tabId, version: currentVersion, isDirty: false, content: current.content }
      }
      throw new Error('conflict')
    }
    const recheck = (): void => {
      assertSaveStillOwned(runtime, worktreeId, tabId, tab.record.file.filePath, expectations)
    }
    recheck()
    await runtime.writeHostMarkdownFile({
      worktreeId,
      relativePath: tab.record.file.relativePath,
      content,
      executionHostId: expectations.executionHostId,
      sshTargetId: expectations.sshTargetId,
      sshConnectionGeneration: expectations.sshConnectionGeneration,
      beforeWrite: recheck
    })
    // Why no ownership recheck here: the bytes have landed; the verify read is the post-condition.
    const verified = await readDocument(runtime, tab)
    if (verified.content !== content) {
      throw new Error('save_verification_failed')
    }
    return { tabId, version: hashMarkdownContent(verified.content), isDirty: false, content }
  })
}
