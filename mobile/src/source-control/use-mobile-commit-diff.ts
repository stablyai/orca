import { useEffect, useMemo, useState } from 'react'
import { translate } from '../i18n/mobile-i18n'
import type { ConnectionState } from '../transport/types'
import type { RpcClient } from '../transport/rpc-client'
import { settleMobileReviewFileDiff } from '../session/mobile-diff-review-loaders'
import { reviewCommitFileDiffRead } from '../session/mobile-diff-review-operations'
import type { ReviewDiffState } from '../session/mobile-diff-review-screen-model'
import type { MobileGitChangedFile } from './git-compare-reply-schema'
import { orderMobileCommitFiles } from './mobile-commit-files'
import { useMobileCommitFiles } from './use-mobile-commit-files'
import { useMobileSourceControlSettings } from './mobile-source-control-settings'
import { shouldIgnoreTrimWhitespace } from '../../../src/shared/diff-whitespace'

function fileKey(commitId: string, file: MobileGitChangedFile): string {
  return `commit\0${commitId}\0${file.oldPath ?? ''}\0${file.path}`
}

// Steps through one commit's files in tree order, loading each with git.commitDiff.
export function useMobileCommitDiff(input: {
  client: RpcClient | null
  connState: ConnectionState
  worktreeId: string
  commitId: string
  initialFilePath: string
}) {
  const { client, connState, worktreeId, commitId, initialFilePath } = input
  const commitFiles = useMobileCommitFiles({ client, connState, worktreeId, commitId })
  const files = useMemo(
    () => (commitFiles.files ? orderMobileCommitFiles(commitFiles.files) : null),
    [commitFiles.files]
  )
  const [selectedPath, setSelectedPath] = useState(initialFilePath)
  const foundIndex = files?.findIndex((file) => file.path === selectedPath) ?? -1
  const index = Math.max(foundIndex, 0)
  const currentFile = files?.[index] ?? null
  const currentKey = currentFile ? fileKey(commitId, currentFile) : null
  const [diff, setDiff] = useState<ReviewDiffState>({ kind: 'idle' })
  const [diffReloadNonce, setDiffReloadNonce] = useState(0)
  const parentOid = commitFiles.parentOid
  const { diffShowWhitespace } = useMobileSourceControlSettings(client, connState).settings
  const filePath = currentFile?.path ?? null
  const oldPath = currentFile?.oldPath
  const deleted = currentFile?.status === 'deleted'

  useEffect(() => {
    if (filePath === null || !currentKey || !client || connState !== 'connected') {
      return
    }
    if (parentOid === undefined) {
      // git.commitDiff reads a missing parent as an empty file; never show that as the change.
      setDiff({
        kind: 'error',
        itemKey: currentKey,
        message: translate('sourceControl.commitDiff.parentUnknown', 'Unable to load this diff')
      })
      return
    }
    // Keep a loaded diff for this file through a reconnect instead of flashing a spinner.
    setDiff((prev) =>
      prev.kind === 'ready' && prev.itemKey === currentKey
        ? prev
        : { kind: 'loading', itemKey: currentKey }
    )
    const controller = new AbortController()
    void (async () => {
      try {
        const reply = await reviewCommitFileDiffRead.request(client, {
          worktree: `id:${worktreeId}`,
          filePath,
          commitOid: commitId,
          parentOid,
          ...(oldPath ? { oldPath } : {})
        })
        const next = settleMobileReviewFileDiff(
          { reply, interpret: (settled) => reviewCommitFileDiffRead.interpret(settled) },
          {
            itemKey: currentKey,
            filePath,
            deleted,
            ignoreTrimWhitespace: shouldIgnoreTrimWhitespace(diffShowWhitespace),
            signal: controller.signal
          }
        )
        if (!controller.signal.aborted) {
          setDiff(next)
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          // A failed reconnect read must not erase a diff already on screen.
          setDiff((prev) =>
            prev.kind === 'ready' && prev.itemKey === currentKey
              ? prev
              : {
                  kind: 'error',
                  itemKey: currentKey,
                  message:
                    error instanceof Error
                      ? error.message
                      : translate('session.diffReviewLoaders.diffLoadFailed', 'Unable to load diff')
                }
          )
        }
      }
    })()
    return () => controller.abort()
  }, [
    client,
    commitId,
    connState,
    currentKey,
    deleted,
    diffReloadNonce,
    diffShowWhitespace,
    filePath,
    oldPath,
    parentOid,
    worktreeId
  ])

  const move = (direction: 'previous' | 'next') => {
    if (!files || files.length === 0) {
      return
    }
    const nextIndex = (index + (direction === 'next' ? 1 : -1) + files.length) % files.length
    setSelectedPath(files[nextIndex]!.path)
  }

  return {
    files,
    filesError: commitFiles.error,
    reloadFiles: commitFiles.reload,
    index,
    currentFile,
    currentKey,
    diff: currentKey && 'itemKey' in diff && diff.itemKey === currentKey ? diff : null,
    reloadDiff: () => setDiffReloadNonce((n) => n + 1),
    move
  }
}
