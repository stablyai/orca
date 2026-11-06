import type { AgentJournalItemBody } from '../../../shared/agent-session/journal/agent-session-journal-types'
import type { GitHubPRRefreshCandidate } from '../../../shared/github/pull-request-refresh-types'
import type { PRInfo } from '../../../shared/github/pull-request-types'
import { pullRequestsOpenedBy } from '../../../shared/native-chat/tools/native-chat-opened-pull-requests'
import { nativeChatToolCallScript } from '../../../shared/native-chat/tools/native-chat-tool-call-script'
import type { JournalRow } from '../../native-chat/agent-session-journal/journal-row-schema'
import { gitPushUpdates, runsGitPush, type GitPushUpdate } from './git-push-update-lines'
import type { PRChatAction } from './pr-watch-tables'
import { parsePRKey, prKeyOf, prWatchCandidate, type PRWatchWorkspace } from './pr-watch-types'

/** A finished shell call in a chat, with the output the journal kept for it. */
export type PRChatToolCall = {
  chatId: string
  anchor: { itemId: string; revision: number }
  script: string
  output: string
  /** Where the call ran, when the agent reports it (Codex does; Claude's Bash does not). */
  cwd: string | null
}

export type PRChatOpened = { owner: string; repo: string; forgeHost: string; number: number }

/** The calls in a committed batch that finished, each seen once per item revision. */
export function finishedShellCalls(chatId: string, rows: readonly JournalRow[]): PRChatToolCall[] {
  return rows.flatMap((row) => {
    if (row.kind !== 'item') {
      return []
    }
    const body: AgentJournalItemBody = row.body
    if (body.kind !== 'tool-call' || (body.state !== 'completed' && body.state !== 'failed')) {
      return []
    }
    const script = nativeChatToolCallScript(body.name, body.input)
    if (!script) {
      return []
    }
    const input = body.input
    const cwd =
      input && typeof input === 'object' && 'cwd' in input && typeof input.cwd === 'string'
        ? input.cwd
        : null
    return [
      {
        chatId,
        anchor: { itemId: row.itemId, revision: row.revision },
        script,
        // The journal keeps a bounded head of long output; it is all the evidence there is.
        output: body.output?.head ?? '',
        cwd
      }
    ]
  })
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

/** A push this call made, awaiting a read that shows which pull request it updated. */
export type PendingPRChatPush = {
  chatId: string
  anchor: { itemId: string; revision: number }
  /** The chat's checkout, read by branch to find the PR the push updated. */
  candidate: GitHubPRRefreshCandidate
  updates: GitPushUpdate[]
  deadline: number
}

export function pushUpdatesByCall(call: PRChatToolCall): GitPushUpdate[] {
  return runsGitPush(call.script) ? gitPushUpdates(call.output) : []
}

/** The push updated this PR's own branch, to the head GitHub now shows when the line named one. */
export function pushMatchesPullRequest(push: PendingPRChatPush, pr: PRInfo): boolean {
  return push.updates.some(
    (update) =>
      update.branch === pr.headRefName &&
      (update.newSha === null || (pr.headSha?.startsWith(update.newSha) ?? false))
  )
}

const PUSH_VERIFY_MS = 2 * 60_000
const PUSH_VERIFY_RETRY_MS = 20_000

type RecorderDeps = {
  chatWorkspace: (chatId: string) => Promise<PRWatchWorkspace | null>
  /** The GitHub repositories the checkout's remotes name, forks included. */
  repositories: (
    workspace: PRWatchWorkspace
  ) => Promise<readonly { owner: string; repo: string; host?: string }[]>
  /** Reads the checkout's PR by branch soon, as after any push. */
  readAfterPush: (candidate: GitHubPRRefreshCandidate) => void
  /** Saves a verified action and starts or renews its PR's watch. */
  record: (action: PRChatAction, candidate: GitHubPRRefreshCandidate) => void
  later: (run: () => void, delayMs: number) => void
  now: () => number
}

/** Turns a chat's finished calls into verified PR actions: a create's own URL, or a push GitHub shows. */
export class PRChatActionRecorder {
  private readonly pushes = new Set<PendingPRChatPush>()

  constructor(private readonly deps: RecorderDeps) {}

  clear(): void {
    this.pushes.clear()
  }

  async record(calls: readonly PRChatToolCall[]): Promise<void> {
    for (const call of calls) {
      const opened = pullRequestsOpenedByCall(call)
      const updates = pushUpdatesByCall(call)
      if (opened.length === 0 && updates.length === 0) {
        continue
      }
      const workspace = await this.deps.chatWorkspace(call.chatId)
      if (!workspace) {
        continue
      }
      if (opened.length > 0) {
        await this.recordOpened(call, workspace, opened)
      }
      // A push from another checkout can't be matched to this chat's PR: an intended miss.
      if (updates.length > 0 && (call.cwd === null || call.cwd === workspace.checkoutPath)) {
        this.awaitPush(call, workspace, updates)
      }
    }
  }

  /** Only a PR in one of the chat repository's own GitHub remotes gets lines. */
  private async recordOpened(
    call: PRChatToolCall,
    workspace: PRWatchWorkspace,
    opened: readonly PRChatOpened[]
  ): Promise<void> {
    const candidates = await this.deps.repositories(workspace)
    for (const pr of opened) {
      const ownRepo = candidates.some(
        (candidate) =>
          candidate.owner.toLowerCase() === pr.owner.toLowerCase() &&
          candidate.repo.toLowerCase() === pr.repo.toLowerCase() &&
          (candidate.host ?? 'github.com').toLowerCase() === pr.forgeHost.toLowerCase()
      )
      if (ownRepo) {
        const action = { chatId: call.chatId, anchor: call.anchor, ...pr }
        this.deps.record(
          { ...action, kind: 'opened', headSha: null, observedAt: this.deps.now() },
          prWatchCandidate(workspace, pr.number)
        )
      }
    }
  }

  private awaitPush(call: PRChatToolCall, workspace: PRWatchWorkspace, updates: GitPushUpdate[]) {
    const candidate = prWatchCandidate(workspace, null)
    const push: PendingPRChatPush = {
      chatId: call.chatId,
      anchor: call.anchor,
      candidate,
      updates,
      deadline: this.deps.now() + PUSH_VERIFY_MS
    }
    this.pushes.add(push)
    // GitHub can lag the push; read again until the PR shows it or the window closes.
    const read = () => {
      if (this.pushes.has(push) && this.deps.now() >= push.deadline) {
        this.pushes.delete(push)
      }
      if (this.pushes.has(push)) {
        this.deps.readAfterPush(candidate)
        this.deps.later(read, PUSH_VERIFY_RETRY_MS)
      }
    }
    read()
  }

  /** Runs on every read before it is evaluated, so the push's own result reaches its chat. */
  verify(candidate: GitHubPRRefreshCandidate, pr: PRInfo, observedAt: number): void {
    const parsed = prKeyOf(pr)
    const key = parsed ? parsePRKey(parsed) : null
    if (!key) {
      return
    }
    for (const push of this.pushes) {
      if (push.candidate.repoPath !== candidate.repoPath || !pushMatchesPullRequest(push, pr)) {
        continue
      }
      this.pushes.delete(push)
      this.deps.record(
        {
          chatId: push.chatId,
          anchor: push.anchor,
          forgeHost: key.host,
          owner: key.owner,
          repo: key.repo,
          number: key.number,
          kind: 'pushed',
          headSha: pr.headSha ?? null,
          observedAt
        },
        {
          ...push.candidate,
          linkedPRNumber: key.number,
          cacheKey: `${push.candidate.cacheKey}#${key.number}`
        }
      )
    }
  }
}
