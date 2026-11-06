import type { AgentJournalItemBody } from '../../../shared/agent-session/journal/agent-session-journal-types'
import type { PRInfo } from '../../../shared/github/pull-request-types'
import { pullRequestsOpenedBy } from '../../../shared/native-chat/tools/native-chat-opened-pull-requests'
import { nativeChatToolCallScript } from '../../../shared/native-chat/tools/native-chat-tool-call-script'
import { gitPushUpdates, runsGitPush, type GitPushUpdate } from './git-push-update-lines'

/** A finished shell call in a chat, with the output the journal kept for it. */
export type PRChatToolCall = {
  chatId: string
  anchor: { itemId: string; revision: number }
  script: string
  output: string
  finishedAt: number
}

export type PRChatOpened = { owner: string; repo: string; forgeHost: string; number: number }

/** One journal item as a finished shell call, or null when it is anything else. */
export function finishedShellCall(
  chatId: string,
  item: { itemId: string; revision: number; body: AgentJournalItemBody },
  finishedAt: number
): PRChatToolCall | null {
  const { body } = item
  if (body.kind !== 'tool-call' || (body.state !== 'completed' && body.state !== 'failed')) {
    return null
  }
  const script = nativeChatToolCallScript(body.name, body.input)
  return script
    ? {
        chatId,
        anchor: { itemId: item.itemId, revision: item.revision },
        script,
        // The journal keeps a bounded head of long output; it is all the evidence there is.
        output: body.output?.head ?? '',
        finishedAt
      }
    : null
}

/** GitHub pull requests the call created. Other hosts get no CI lines yet. */
export function pullRequestsOpenedByCall(call: PRChatToolCall): PRChatOpened[] {
  return pullRequestsOpenedBy(call.script, call.output).flatMap((opened) =>
    opened.provider === 'github'
      ? [
          {
            owner: opened.slug.owner,
            repo: opened.slug.repo,
            forgeHost: opened.slug.host ?? 'github.com',
            number: opened.number
          }
        ]
      : []
  )
}

export function pushUpdatesByCall(call: PRChatToolCall): GitPushUpdate[] {
  return runsGitPush(call.script) ? gitPushUpdates(call.output) : []
}

/** A push target as resolved through the checkout's config, SSH aliases included. */
export type PushRemote = { host: string; owner: string; repo: string }

/**
 * The head this push gave the PR, when its own update line proves the PR's head branch, in the
 * PR's own repository on the PR's own forge host, was the target. Matching commit content never
 * overrides a different target. When the PR still shows the pushed commit, that is its head; with
 * no commit named (a new branch) the PR's head is taken; otherwise a later push moved the PR on
 * (`superseded`), and the head is git's abbreviation, to be resolved before it is saved.
 */
export function pushedPullRequestHead(
  update: { branch: string; newSha: string | null },
  remote: PushRemote | null,
  pr: PRInfo
): { headSha: string; superseded: boolean } | null {
  const head = pr.headRepo
  if (
    !remote ||
    !head ||
    !pr.headSha ||
    update.branch !== pr.headRefName ||
    remote.owner.toLowerCase() !== head.owner.toLowerCase() ||
    remote.repo.toLowerCase() !== head.repo.toLowerCase() ||
    remote.host.toLowerCase() !== (head.host ?? 'github.com').toLowerCase()
  ) {
    return null
  }
  if (!update.newSha || pr.headSha.startsWith(update.newSha)) {
    return { headSha: pr.headSha, superseded: false }
  }
  return { headSha: update.newSha, superseded: true }
}
