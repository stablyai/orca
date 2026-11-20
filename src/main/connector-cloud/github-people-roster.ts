// "Who can ask" › Add on GitHub: the people of the connected repositories and organizations, read
// once per picker open through the host's own gh, then filtered by the picker as the owner types.
// The cloud only resolves one exact username, so typing a teammate's first name found a stranger.
//
// Phases of one read, per host process:
// - Admission: one read holds the gh slot at a time. A read for a scope already running or
//   waiting joins that read. Otherwise it waits for the slot, at most MAX_WAITING_READS of them,
//   each for at most QUEUE_WAIT_MS; past either bound it answers `busy` and starts nothing.
// - Run: one logical gh call (the runner may try another gh binary if the first is missing,
//   one at a time); the runner kills a child at ROSTER_TIMEOUT_MS and nothing retries.
// - Answer: as soon as the runner settles the call, whether or not its child has ended.
// - Drain: the slot frees only when the runner reports every child of the read terminated
//   (lifetime hooks). An end that is never confirmed keeps the slot: later reads answer `busy`
//   after their wait, and the slot frees only if that end is confirmed later, or when the app
//   restarts. Nothing frees it on a timer, and nothing is cached once answered.
import { ghExecFileAsync } from '../git/command-runner/hosted-cli/gh-exec-file'
import {
  createGhLogicalLifetime,
  type GhCaptureLifetimeHooks
} from '../git/command-runner/hosted-cli/gh-capture-lifetime'
import { extractExecError } from '../git/command-runner/process-capture/exec-error'
import type { BotGitHubRoster } from '../../shared/connector-bot-github-contract'
import type { GitHubPeopleScope } from '../../shared/bots/github-people-scope'
import type { GitHubPerson } from '../../shared/bots/github-people-rank'
import { readRoster, rosterQuery, targetOf, type GitHubPeopleTarget } from './github-people-query'

export const ROSTER_TIMEOUT_MS = 10_000
/** Reads waiting for the slot behind the one holding it; more answer `busy` at once. */
export const MAX_WAITING_READS = 2
/** How long a waiting read waits for the slot before answering `busy`. Logical only: it releases
 *  the caller, never the slot. */
export const QUEUE_WAIT_MS = 15_000

export type RosterRun = (args: string[], hooks: GhCaptureLifetimeHooks) => Promise<string>

// No retries (`idempotent: false`): one logical call per read.
const ghRun: RosterRun = async (args, hooks) => {
  try {
    const { stdout } = await ghExecFileAsync(
      args,
      { encoding: 'utf-8', host: 'github.com', idempotent: false, timeout: ROSTER_TIMEOUT_MS },
      hooks
    )
    return stdout
  } catch (error) {
    // A GraphQL error on one source exits non-zero but still prints the others' data.
    return extractExecError(error).stdout
  }
}

type Waiting = {
  key: string
  target: GitHubPeopleTarget
  omitted: boolean
  answer: (roster: BotGitHubRoster) => void
  timer: ReturnType<typeof setTimeout>
}

export class GitHubPeopleRosters {
  /** A read's child has not been confirmed ended. */
  private held = false
  private waiting: Waiting[] = []
  /** Reads not yet answered, by scope, so callers asking for the same scope share one. */
  private unanswered = new Map<string, Promise<BotGitHubRoster>>()

  constructor(
    private readonly run: RosterRun = ghRun,
    private readonly queueWaitMs: number = QUEUE_WAIT_MS
  ) {}

  read(scope: GitHubPeopleScope): Promise<BotGitHubRoster> {
    const key = JSON.stringify(scope)
    const shared = this.unanswered.get(key)
    if (shared) {
      return shared
    }
    const { target, dropped } = targetOf(scope)
    if (target.repositories.length + target.owners.length === 0) {
      return Promise.resolve({ status: 'unavailable' })
    }
    const omitted = dropped || scope.more
    if (this.held && this.waiting.length >= MAX_WAITING_READS) {
      return Promise.resolve({ status: 'busy' })
    }
    const answer = this.held
      ? new Promise<BotGitHubRoster>((resolve) => {
          const entry: Waiting = {
            key,
            target,
            omitted,
            answer: resolve,
            // Waited long enough: answer busy and leave the queue, starting nothing.
            timer: setTimeout(() => {
              this.waiting = this.waiting.filter((other) => other !== entry)
              resolve({ status: 'busy' })
            }, this.queueWaitMs)
          }
          this.waiting.push(entry)
        })
      : this.start(target, omitted)
    const tracked = answer.finally(() => {
      if (this.unanswered.get(key) === tracked) {
        this.unanswered.delete(key)
      }
    })
    this.unanswered.set(key, tracked)
    return tracked
  }

  /** Waiting reads, for tests and diagnostics. */
  get waitingCount(): number {
    return this.waiting.length
  }

  private start(target: GitHubPeopleTarget, omitted: boolean): Promise<BotGitHubRoster> {
    this.held = true
    const lifetime = createGhLogicalLifetime()
    void lifetime.terminated.then(() => this.release())
    return this.readNow(target, omitted, lifetime)
  }

  /** The held read's children have ended: the next waiting read, if any, takes the slot. */
  private release(): void {
    this.held = false
    const next = this.waiting.shift()
    if (next) {
      clearTimeout(next.timer)
      void this.start(next.target, next.omitted).then(next.answer)
    }
  }

  private async readNow(
    target: GitHubPeopleTarget,
    omitted: boolean,
    lifetime: ReturnType<typeof createGhLogicalLifetime>
  ): Promise<BotGitHubRoster> {
    const built = rosterQuery(target)
    const args = ['api', 'graphql', '-f', `query=${built.document}`]
    for (const [key, value] of Object.entries(built.vars)) {
      args.push('-f', `${key}=${value}`)
    }
    let stdout = ''
    try {
      stdout = await this.run(args, lifetime.hooks)
    } catch {
      stdout = ''
    } finally {
      // The answer goes out now; the slot frees when `terminated` settles.
      lifetime.seal()
    }
    const read = readRoster(stdout, target)
    if (!read || read.sourcesRead === 0) {
      return { status: 'unavailable' }
    }
    const byId = new Map<string, GitHubPerson>()
    for (const person of read.people) {
      if (!byId.has(person.id)) {
        byId.set(person.id, person)
      }
    }
    return {
      status: 'read',
      people: [...byId.values()],
      from: read.from,
      complete: !read.lossy,
      omitted,
      cut: read.cut,
      ...(read.viewer ? { searchedAs: read.viewer } : {})
    }
  }
}

let shared: GitHubPeopleRosters | null = null
/** The host's one roster slot. */
export function gitHubPeopleRosters(): GitHubPeopleRosters {
  shared ??= new GitHubPeopleRosters()
  return shared
}
