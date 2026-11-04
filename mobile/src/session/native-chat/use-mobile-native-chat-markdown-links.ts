import { useEffect, useMemo, useRef, useState } from 'react'
import { z } from 'zod'
import { relativePathInsideRoot } from '../../../../src/shared/cross-platform-path'
import {
  githubReferenceRepo,
  type GitHubRepoReference
} from '../../../../src/shared/github/github-reference-links'
import { githubRepoIdentityKey } from '../../../../src/shared/github/repository-identity-key'
import {
  createNativeChatFileLinkChecker,
  type NativeChatFileLinkExistence
} from '../../../../src/shared/native-chat/native-chat-file-link-existence'
import {
  createPathExistenceBatch,
  requirePathExistenceResults
} from '../../../../src/shared/path-existence-batch'
import type { Repo } from '../../../../src/shared/repo-types'
import { resolveTerminalFileLink } from '../../../../src/shared/terminal/links/terminal-links'
import { getRepoIdFromWorktreeId } from '../../../../src/shared/worktree/id'
import {
  useRecheckNativeChatFileLinksAfterTurn,
  type MobileMarkdownLinks
} from '../../components/mobile-markdown-links-context'
import type { RpcClient } from '../../transport/rpc-client'
import { bindDeferredRpcOperation, defineRpcOperation } from '../../transport/rpc-operation'
import { rpcResultVariant } from '../../transport/rpc-operation-result-reader'
import type { ConnectionState } from '../../transport/types'
import { fetchGithubRepoSlug } from '../github-pr-rpc'
import { nativeChatRepoListRead } from '../mobile-session-read-operations'

const chatPathsExistRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'files.chat-paths-exist',
    method: 'files.pathsExist',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('chat-paths-exist', z.array(z.unknown()))
  })
)

/** Paths in a chat's text, checked in batches against the chat's workspace on its host. */
export function createMobileNativeChatFileLinkExistence(
  client: RpcClient,
  worktreeId: string,
  worktreePath: string
): NativeChatFileLinkExistence {
  const pathsExist = createPathExistenceBatch<string>({
    groupKey: (worktree) => worktree,
    run: async (worktree, relativePaths) =>
      requirePathExistenceResults(
        chatPathsExistRead.interpret(
          await chatPathsExistRead.request(client, { worktree, relativePaths })
        ),
        relativePaths.length
      )
  })
  const worktree = `id:${worktreeId}`
  return createNativeChatFileLinkChecker<string>({
    lookup: (link) => {
      const resolved = resolveTerminalFileLink(link, worktreePath, null)
      const relativePath = resolved
        ? relativePathInsideRoot(worktreePath, resolved.absolutePath)
        : null
      if (relativePath === '') {
        return { kind: 'linked' }
      }
      if (/[\\/]$/.test(link.pathText)) {
        return { kind: 'plain' }
      }
      // Why: the host checks only its workspace in batches; outside paths keep opening on tap as before.
      if (relativePath === null) {
        return { kind: 'linked' }
      }
      return { kind: 'ask', key: relativePath, target: relativePath }
    },
    ask: (relativePath) => pathsExist(worktree, relativePath)
  })
}

type RepoLinkFields = Pick<Repo, 'id' | 'upstream' | 'issueSourcePreference'>

async function loadGitHubReferenceRepo(
  client: RpcClient,
  worktreeId: string
): Promise<GitHubRepoReference | null> {
  const [slug, repos] = await Promise.all([
    fetchGithubRepoSlug(client, worktreeId),
    nativeChatRepoListRead.request(client).then((reply) => nativeChatRepoListRead.interpret(reply))
  ])
  if (!slug.ok || !slug.result || !repos.accepted) {
    return null
  }
  const repoId = getRepoIdFromWorktreeId(worktreeId)
  const repo = (repos.value as RepoLinkFields[]).find((candidate) => candidate.id === repoId)
  return repo ? githubReferenceRepo(repo, githubRepoIdentityKey(slug.result)) : null
}

/** One per chat: file-path existence and the repo bare `#123` refs point to. */
export function useMobileNativeChatMarkdownLinks({
  enabled,
  client,
  connState,
  worktreeId,
  worktreePath,
  isWorking
}: {
  /** The chat is on screen; nothing is asked otherwise. */
  enabled: boolean
  client: RpcClient | null
  connState: ConnectionState
  worktreeId: string
  worktreePath: string | null
  isWorking: boolean
}): MobileMarkdownLinks {
  const connected = connState === 'connected'
  const fileLinks = useMemo(
    () =>
      enabled && client && worktreePath
        ? createMobileNativeChatFileLinkExistence(client, worktreeId, worktreePath)
        : null,
    [enabled, client, worktreeId, worktreePath]
  )
  useRecheckNativeChatFileLinksAfterTurn(fileLinks, isWorking)
  useRecheckWhenReconnected(fileLinks, connected)

  const [github, setGithub] = useState<{ worktreeId: string; repo: GitHubRepoReference } | null>(
    null
  )
  // Folder workspaces have no repo; their bare `#123` stays text, as on desktop.
  const asksGithub = enabled && connected && !worktreeId.startsWith('folder:')
  useEffect(() => {
    if (!client || !asksGithub) {
      return
    }
    let active = true
    void loadGitHubReferenceRepo(client, worktreeId)
      .catch(() => null)
      .then((repo) => {
        if (active && repo) {
          setGithub({ worktreeId, repo })
        }
      })
    return () => {
      active = false
    }
  }, [client, asksGithub, worktreeId])
  const githubRepo = github?.worktreeId === worktreeId ? github.repo : null

  return useMemo(() => ({ fileLinks, githubRepo }), [fileLinks, githubRepo])
}

// Why: answers missed while the host was unreachable stay plain until something asks again.
function useRecheckWhenReconnected(
  existence: NativeChatFileLinkExistence | null,
  connected: boolean
): void {
  const seen = useRef<{ existence: NativeChatFileLinkExistence | null; connected: boolean } | null>(
    null
  )
  useEffect(() => {
    const previous = seen.current
    seen.current = { existence, connected }
    if (existence && previous?.existence === existence && !previous.connected && connected) {
      existence.recheck()
    }
  }, [existence, connected])
}
