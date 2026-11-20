// "Who can ask" › Add on GitHub: the people of the connected repositories and organizations, read
// once per picker open through the host's own gh, then filtered by the picker as the owner types.
// The cloud only resolves one exact username, so typing a teammate's first name found a stranger.
//
// Budget, per host process: one gh child at a time. A read runs only after the previous read's
// children have terminated (the runner reports it through the lifetime hooks), so capacity is never
// released on a timer or an unconfirmed kill; a child that never confirms keeps the slot, and later
// reads answer `busy` once MAX_WAITING_READS are queued. Callers asking for the same scope share
// one read; nothing is cancelled and nothing is cached once answered. Each child is killed by the
// shared runner at ROSTER_TIMEOUT_MS and never retried.
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
/** Different scopes waiting behind the running read; more answer `busy`. */
export const MAX_WAITING_READS = 2

export type RosterRun = (args: string[], hooks: GhCaptureLifetimeHooks) => Promise<string>

// No retries (`idempotent: false`): one child per read, so the slot's custody is that child's.
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

export class GitHubPeopleRosters {
  /** Settles once the latest read's children have terminated; the next read starts after it. */
  private slot: Promise<void> = Promise.resolve()
  /** Reads not yet answered, by scope: running or waiting for the slot. */
  private reads = new Map<string, Promise<BotGitHubRoster>>()

  constructor(private readonly run: RosterRun = ghRun) {}

  read(scope: GitHubPeopleScope): Promise<BotGitHubRoster> {
    const key = JSON.stringify(scope)
    const shared = this.reads.get(key)
    if (shared) {
      return shared
    }
    if (this.reads.size >= 1 + MAX_WAITING_READS) {
      return Promise.resolve({ status: 'busy' })
    }
    const { target, dropped } = targetOf(scope)
    if (target.repositories.length + target.owners.length === 0) {
      return Promise.resolve({ status: 'unavailable' })
    }
    const previous = this.slot
    let release = (): void => {}
    this.slot = new Promise<void>((resolve) => {
      release = resolve
    })
    const answer = previous
      .then(() => this.readNow(target, dropped || scope.more, release))
      .finally(() => this.reads.delete(key))
    this.reads.set(key, answer)
    return answer
  }

  private async readNow(
    target: GitHubPeopleTarget,
    partial: boolean,
    release: () => void
  ): Promise<BotGitHubRoster> {
    const built = rosterQuery(target)
    const args = ['api', 'graphql', '-f', `query=${built.document}`]
    for (const [key, value] of Object.entries(built.vars)) {
      args.push('-f', `${key}=${value}`)
    }
    const lifetime = createGhLogicalLifetime()
    let stdout = ''
    try {
      stdout = await this.run(args, lifetime.hooks)
    } catch {
      stdout = ''
    } finally {
      // The answer goes out now; the slot frees only when every child of this read has ended.
      lifetime.seal()
      void lifetime.terminated.then(release)
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
      complete: !read.lossy && !partial,
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
