import { useCallback, useEffect, useState } from 'react'
import { translate } from '../i18n/mobile-i18n'
import type { ConnectionState } from '../transport/types'
import type { RpcClient } from '../transport/rpc-client'
import { gitCommitCompareRead } from './mobile-git-read-operations'
import type { MobileGitChangedFile } from './git-compare-reply-schema'

function loadFilesFailedMessage(): string {
  return translate('sourceControl.commitDetail.loadFilesFailed', 'Unable to load commit files')
}

function invalidCommitLinkMessage(): string {
  return translate('sourceControl.commitDetail.invalidLink', 'This link does not name a commit')
}

export type MobileCommitFilesState = {
  files: MobileGitChangedFile[] | null
  // Undefined when the reply carried no readable summary; null for a root commit.
  parentOid: string | null | undefined
  error: string | null
  reload: () => void
}

type Loaded = {
  commit: string
  files: MobileGitChangedFile[] | null
  parentOid: string | null | undefined
  error: string | null
}

// Loads one commit's changed files; an outage waits for reconnect instead of reading as "no files".
export function useMobileCommitFiles(input: {
  client: RpcClient | null
  connState: ConnectionState
  worktreeId: string
  commitId: string
}): MobileCommitFilesState {
  const { client, connState, worktreeId, commitId } = input
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [reloadNonce, setReloadNonce] = useState(0)
  const commit = `${worktreeId}\0${commitId}`
  const current = loaded?.commit === commit ? loaded : null
  const invalidLink = commitId === ''

  useEffect(() => {
    if (!client || connState !== 'connected' || !worktreeId || !commitId) {
      return
    }
    let stale = false
    setLoaded((prev) => (prev?.commit === commit ? { ...prev, error: null } : prev))
    void gitCommitCompareRead
      .request(client, { worktree: `id:${worktreeId}`, commitId })
      .then((reply) => {
        const compared = gitCommitCompareRead.interpret(reply)
        const summary = compared.summary
        if (summary?.status !== undefined && summary.status !== 'ready') {
          throw new Error(summary.errorMessage ?? loadFilesFailedMessage())
        }
        if (!stale) {
          setLoaded({
            commit,
            files: compared.entries,
            parentOid: compared.summary?.parentOid,
            error: null
          })
        }
      })
      .catch((err: unknown) => {
        if (stale) {
          return
        }
        const error = err instanceof Error ? err.message : loadFilesFailedMessage()
        // A refused refresh keeps the files already shown.
        setLoaded((prev) => ({
          commit,
          files: prev?.commit === commit ? prev.files : null,
          parentOid: prev?.commit === commit ? prev.parentOid : undefined,
          error
        }))
      })
    return () => {
      stale = true
    }
  }, [client, commit, commitId, connState, reloadNonce, worktreeId])

  const reload = useCallback(() => setReloadNonce((n) => n + 1), [])
  return {
    files: current?.files ?? null,
    parentOid: current?.parentOid,
    error: invalidLink ? invalidCommitLinkMessage() : (current?.error ?? null),
    reload
  }
}
