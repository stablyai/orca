import { useEffect, useMemo, useState } from 'react'
import {
  detectCommitAgent,
  detectCommitAuthorAgent,
  stripAgentCoAuthorTrailers
} from '../../../src/shared/commit-agent-attribution'
import {
  resolveGitHistoryUnpushedIds,
  type GitHistoryUpstreamVerdict
} from '../../../src/shared/git-history-push-state'
import type { TuiAgent } from '../../../src/shared/tui-agent'
import type { ConnectionState } from '../transport/types'
import type { RpcClient } from '../transport/rpc-client'
import type { MobileGitHistoryResult } from './git-history-reply-schema'
import { fetchMobileGitHistory } from './mobile-git-history'
import { shortGitHash } from '../../../src/shared/git-history-log-parser'
import { toGitHistoryItem } from './mobile-commit-timeline'
import { recallMobileCommitHistory } from './mobile-commit-history-cache'

export type MobileCommitDetail = {
  shortId: string
  subject: string
  body: string
  message: string
  author: string
  agent: TuiAgent | null
  // True when a trailer credits the agent on a person's commit, so the author line names both.
  agentCoAuthored: boolean
  timestamp: number | null
  // Null on a detached HEAD, where there is no branch to have pushed.
  unpushed: boolean | null
}

// git.history carries the message, author and push state; the commit is on the page the timeline showed.
export function findMobileCommitDetail(
  result: MobileGitHistoryResult,
  commitId: string,
  upstream: GitHistoryUpstreamVerdict | null
): MobileCommitDetail | null {
  const item = result.items.find((candidate) => candidate.id === commitId)
  if (!item) {
    return null
  }
  const subject = item.subject ?? ''
  const message = item.message ?? subject

  const agent = detectCommitAgent({ authorEmail: item.authorEmail, message })
  const bodyText = message.split('\n').slice(1).join('\n')
  const body = (agent ? stripAgentCoAuthorTrailers(bodyText, agent) : bodyText).trim()
  const unpushed = resolveGitHistoryUnpushedIds(
    { ...result, items: result.items.map(toGitHistoryItem) },
    upstream ?? undefined
  )
  return {
    shortId: item.displayId ?? shortGitHash(item.id),
    subject,
    body,
    message,
    author: item.author ?? '',
    agent,
    agentCoAuthored: agent !== null && detectCommitAuthorAgent(item.authorEmail) === null,
    timestamp: item.timestamp ?? null,
    unpushed: unpushed ? unpushed.has(item.id) : null
  }
}

export function useMobileCommitDetail(input: {
  client: RpcClient | null
  connState: ConnectionState
  hostId: string
  worktreeId: string
  commitId: string
}): MobileCommitDetail | null {
  const { client, connState, hostId, worktreeId, commitId } = input
  const remembered = useMemo(() => {
    const remembered = recallMobileCommitHistory(hostId, worktreeId)
    return remembered
      ? findMobileCommitDetail(remembered.result, commitId, remembered.upstream)
      : null
  }, [commitId, hostId, worktreeId])
  const [fetched, setFetched] = useState<{
    commit: string
    detail: MobileCommitDetail | null
  } | null>(null)
  const commit = `${worktreeId}\0${commitId}`

  useEffect(() => {
    if (remembered || !client || connState !== 'connected' || !worktreeId || !commitId) {
      return
    }
    let stale = false
    fetchMobileGitHistory(client, worktreeId, null)
      .then(
        (result) =>
          !stale && setFetched({ commit, detail: findMobileCommitDetail(result, commitId, null) })
      )
      // The files still load from their own read; the header falls back to the sha.
      .catch(() => undefined)
    return () => {
      stale = true
    }
  }, [client, commit, commitId, connState, remembered, worktreeId])

  return remembered ?? (fetched?.commit === commit ? fetched.detail : null)
}
