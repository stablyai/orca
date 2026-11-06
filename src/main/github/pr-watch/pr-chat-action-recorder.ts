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

/** The calls in a committed batch that finished, each seen once per item revision. */
export function finishedShellCalls(chatId: string, rows: readonly JournalRow[]): PRChatToolCall[] {
  return rows.flatMap((row) =>
    row.kind === 'item' ? (finishedShellCall(chatId, row, row.ts) ?? []) : []
  )
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
  /** The chat's project, read by each pushed branch to find the PR the push updated. */
  candidate: GitHubPRRefreshCandidate
  updates: GitPushUpdate[]
  deadline: number
  /** Replayed from the journal after a crash, not seen live. */
  replayed: boolean
  /** A superseded head's full SHA is being resolved; the push stays pending until it is. */
  resolving?: boolean
}

export function pushUpdatesByCall(call: PRChatToolCall): GitPushUpdate[] {
  return runsGitPush(call.script) ? gitPushUpdates(call.output) : []
}

function sameRepository(
  left: { owner: string; repo: string } | null | undefined,
  right: { owner: string; repo: string } | null | undefined
): boolean {
  return (
    !!left &&
    !!right &&
    left.owner.toLowerCase() === right.owner.toLowerCase() &&
    left.repo.toLowerCase() === right.repo.toLowerCase()
  )
}

/**
 * The head this push gave the PR, when its own update line proves the PR's head branch was the
 * target. The new commit, when the PR still shows it, proves it with the repository; with no commit
 * to compare (a new branch) or a PR already moved on, only the full target, forge host included,
 * does. A moved-on head is git's abbreviation (`superseded`), to be resolved before it is saved.
 */
export function pushedPullRequestHead(
  push: PendingPRChatPush,
  pr: PRInfo
): { headSha: string; superseded: boolean } | null {
  const prHost = (pr.headRepo?.host ?? 'github.com').toLowerCase()
  for (const update of push.updates) {
    if (update.branch !== pr.headRefName || !pr.headSha) {
      continue
    }
    const sameRemote = sameRepository(update.remote, pr.headRepo)
    if (update.newSha && pr.headSha.startsWith(update.newSha)) {
      return update.remote === null || sameRemote
        ? { headSha: pr.headSha, superseded: false }
        : null
    }
    if (sameRemote && update.remote?.host === prHost) {
      return update.newSha
        ? { headSha: update.newSha, superseded: true }
        : { headSha: pr.headSha, superseded: false }
    }
  }
  return null
}

const PUSH_VERIFY_MS = 2 * 60_000
const PUSH_VERIFY_RETRY_MS = 20_000

type RecorderDeps = {
  chatWorkspace: (chatId: string) => Promise<PRWatchWorkspace | null>
  /** Whether a call already produced a saved action, so a replay never renews or repeats one. */
  isRecorded: (chatId: string, anchorItemId: string) => boolean
  /** The GitHub repositories the checkout's remotes name, forks included. */
  repositories: (
    workspace: PRWatchWorkspace
  ) => Promise<readonly { owner: string; repo: string; host?: string }[]>
  /** Reads the checkout's PR by branch soon, as after any push. */
  readAfterPush: (candidate: GitHubPRRefreshCandidate) => void
  /** The full SHA GitHub knows for a commit git printed abbreviated; null when it can't say. */
  resolveCommitSha: (
    candidate: GitHubPRRefreshCandidate,
    pr: { host: string; owner: string; repo: string },
    abbreviated: string
  ) => Promise<string | null>
  /** Saves a verified action and starts or renews its PR's watch. `superseded` marks a pushed head
   *  the PR already moved off; `replayed` an action recovered from the journal, not seen live. */
  record: (
    action: PRChatAction,
    candidate: GitHubPRRefreshCandidate,
    how: { superseded: boolean; replayed: boolean }
  ) => void
  now: () => number
}

/** Turns a chat's finished calls into verified PR actions: a create's own URL, or a push GitHub shows. */
export class PRChatActionRecorder {
  private readonly pushes = new Set<PendingPRChatPush>()
  private readonly timers = new Set<ReturnType<typeof setTimeout>>()

  constructor(private readonly deps: RecorderDeps) {}

  clear(): void {
    this.pushes.clear()
    this.timers.forEach((timer) => clearTimeout(timer))
    this.timers.clear()
  }

  /** `replayed` recovers calls already in the journal. Resolves false when some call could not be
   *  handled yet (no workspace), so the caller keeps the replay retryable. */
  async record(calls: readonly PRChatToolCall[], replayed = false): Promise<boolean> {
    let complete = true
    for (const call of calls) {
      if (replayed && this.deps.isRecorded(call.chatId, call.anchor.itemId)) {
        continue
      }
      const opened = pullRequestsOpenedByCall(call)
      const updates = pushUpdatesByCall(call)
      if (opened.length === 0 && updates.length === 0) {
        continue
      }
      const workspace = await this.deps.chatWorkspace(call.chatId)
      if (!workspace) {
        complete = false
        continue
      }
      if (opened.length > 0) {
        await this.recordOpened(call, workspace, opened, replayed)
      }
      // The update lines name the target repository and branch, so any cwd the call ran in counts.
      if (updates.length > 0) {
        this.awaitPush(call, workspace, updates, replayed)
      }
    }
    return complete
  }

  /** Only a PR in one of the chat repository's own GitHub remotes gets lines. */
  private async recordOpened(
    call: PRChatToolCall,
    workspace: PRWatchWorkspace,
    opened: readonly PRChatOpened[],
    replayed: boolean
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
          {
            ...action,
            kind: 'opened',
            headSha: null,
            observedAt: replayed ? call.finishedAt : this.deps.now()
          },
          prWatchCandidate(workspace, pr.number),
          { superseded: false, replayed }
        )
      }
    }
  }

  private awaitPush(
    call: PRChatToolCall,
    workspace: PRWatchWorkspace,
    updates: GitPushUpdate[],
    replayed: boolean
  ) {
    const candidate = prWatchCandidate(workspace, null)
    const push: PendingPRChatPush = {
      chatId: call.chatId,
      anchor: call.anchor,
      candidate,
      updates,
      deadline: this.deps.now() + PUSH_VERIFY_MS,
      replayed
    }
    this.pushes.add(push)
    // Each pushed branch is read by name: `work:review` updated review, whatever is checked out.
    const branches = [...new Set(updates.map((update) => update.branch))]
    // GitHub can lag the push; read again until the PR shows it or the window closes.
    const read = () => {
      if (this.pushes.has(push) && this.deps.now() >= push.deadline) {
        this.pushes.delete(push)
      }
      if (this.pushes.has(push)) {
        for (const branch of branches) {
          this.deps.readAfterPush({
            ...candidate,
            branch,
            cacheKey: `${candidate.cacheKey}>${branch}`
          })
        }
        const timer = setTimeout(() => {
          this.timers.delete(timer)
          read()
        }, PUSH_VERIFY_RETRY_MS)
        timer.unref?.()
        this.timers.add(timer)
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
      const head =
        !push.resolving && push.candidate.repoPath === candidate.repoPath
          ? pushedPullRequestHead(push, pr)
          : null
      if (!head) {
        continue
      }
      const save = (headSha: string) => {
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
            headSha,
            observedAt
          },
          {
            ...push.candidate,
            branch: pr.headRefName ?? push.candidate.branch,
            linkedPRNumber: key.number,
            cacheKey: `${push.candidate.cacheKey}#${key.number}`
          },
          { superseded: head.superseded, replayed: push.replayed }
        )
      }
      if (!head.superseded) {
        save(head.headSha)
        continue
      }
      // Every head is keyed by its full SHA, so a later read of the same commit finds its memory.
      push.resolving = true
      void this.deps
        .resolveCommitSha(push.candidate, key, head.headSha)
        .catch(() => null)
        .then((full) => {
          push.resolving = false
          if (full && this.pushes.has(push)) {
            save(full)
          }
        })
    }
  }
}
