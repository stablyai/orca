import { useEffect, useMemo, useState } from 'react'
import * as z from 'zod'
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
} from '../../../../src/shared/file-access/path-existence-batch'
import { resolveTerminalFileLink } from '../../../../src/shared/terminal/links/terminal-links'
import { getRepoIdFromWorktreeId } from '../../../../src/shared/worktree/id'
import {
  useRecheckNativeChatFileLinksWhenSettled,
  type MobileMarkdownLinks
} from '../../components/mobile-markdown-links-context'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import type { UnvalidatedRpcRequestPort } from '../../transport/rpc/unvalidated-rpc-request-port'
import { isMobileMethodUnavailableError } from '../../transport/rpc/mobile-method-unavailable'
import { isFilePathCodeSpan } from '../../components/markdown-file-path-detection'
import { bindDeferredRpcOperation, defineRpcOperation } from '../../transport/rpc/rpc-operation'
import { rpcResultVariant } from '../../transport/rpc/rpc-operation-result-reader'
import type { ConnectionState } from '../../transport/connection/connection-state'
import { fetchGithubRepoSlug } from '../../source-control/review/github-pr-rpc'
import { nativeChatRepoListRead } from '../agent-launch/mobile-runtime-repo-operations'

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
  client: UnvalidatedRpcRequestPort,
  worktreeId: string,
  worktreePath: string
): NativeChatFileLinkExistence {
  // Why: a host from before this check refuses it; its paths link as the old detector linked them.
  let hostChecks = true
  const pathsExist = createPathExistenceBatch<string>({
    groupKey: (worktree) => worktree,
    run: async (worktree, relativePaths) => {
      const reply = await chatPathsExistRead.request(client, { worktree, relativePaths })
      if (!reply.ok && isMobileMethodUnavailableError(reply.error.code, reply.error.message)) {
        hostChecks = false
        return relativePaths.map((path) => ({ exists: isFilePathCodeSpan(path) }))
      }
      return requirePathExistenceResults(chatPathsExistRead.interpret(reply), relativePaths.length)
    }
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
      // Why: the host checks only its workspace; outside paths link as the old detector linked them.
      if (relativePath === null || !hostChecks) {
        return isFilePathCodeSpan(link.pathText) ? { kind: 'linked' } : { kind: 'plain' }
      }
      return { kind: 'ask', key: relativePath, target: relativePath }
    },
    ask: (relativePath) => pathsExist(worktree, relativePath)
  })
}

// Only the fields the `#123` rule reads; a malformed remote leaves refs as text.
const repoLinkFieldsSchema = z.looseObject({
  id: z.string(),
  upstream: z
    .looseObject({ owner: z.string(), repo: z.string(), host: z.string().optional() })
    .nullish(),
  issueSourcePreference: z.enum(['upstream', 'origin', 'auto']).optional()
})

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
  const repo = repoLinkFieldsSchema.safeParse(repos.value.find((row) => row.id === repoId))
  return repo.success ? githubReferenceRepo(repo.data, githubRepoIdentityKey(slug.result)) : null
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
  /** The chat is on screen; the `#123` repo is looked up only then. */
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
      client && worktreePath
        ? createMobileNativeChatFileLinkExistence(client, worktreeId, worktreePath)
        : null,
    [client, worktreeId, worktreePath]
  )
  useRecheckNativeChatFileLinksWhenSettled(fileLinks, isWorking)
  // Why: answers missed while the host was unreachable stay plain until something asks again.
  useRecheckNativeChatFileLinksWhenSettled(fileLinks, !connected)

  const [github, setGithub] = useState<{ worktreeId: string; repo: GitHubRepoReference } | null>(
    null
  )
  const githubRepo = github?.worktreeId === worktreeId ? github.repo : null
  // Folder workspaces have no repo; their bare `#123` stays text, as on desktop.
  const asksGithub =
    enabled && connected && githubRepo === null && !worktreeId.startsWith('folder:')
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

  return useMemo(() => ({ fileLinks, githubRepo }), [fileLinks, githubRepo])
}
