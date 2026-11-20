// "Who can ask" › Add on GitHub: the people of the connected repositories and organizations, read
// through the host's own gh and filtered by the picker as the owner types. The cloud only resolves
// one exact username, so typing a teammate's first name found a stranger.
//
// One read per app run, per host process. The first request starts it; every later request, from
// any picker and for any scope, gets that same read (marked `reused`, with when it ran) and never
// starts another gh child. Why: the runner can't prove a gh process tree has ended (on Windows it
// reports a root's close or a lost worker; on macOS and Linux a normal root close, even if its
// group remains), so this feature never runs a second child behind one that may still be alive.
// The exact-username lookup stays live; restarting the app (this host's Orca) reads the list
// again. A failed read keeps the latch too: the runner may have started a gh attempt (another
// binary, a WSL fallback) before failing, so no failure proves that no process ever existed.
//
// Scale: one logical read and its gh attempts per host per app run. Each picker open asks for
// it once (one RPC per session); each keystroke filters locally and runs only the cloud's
// exact-username lookup.
//
// The one read: one logical gh call (the runner may try another gh binary if the first is
// missing, one at a time), killed by the runner at ROSTER_TIMEOUT_MS and never retried. Its answer
// goes out as soon as the runner settles the call.
import { ghExecFileAsync } from '../git/command-runner/hosted-cli/gh-exec-file'
import { extractExecError } from '../git/command-runner/process-capture/exec-error'
import type { BotGitHubRoster } from '../../shared/connector-bot-github-contract'
import type { GitHubPeopleScope } from '../../shared/bots/github-people-scope'
import type { GitHubPerson } from '../../shared/bots/github-people-rank'
import { readRoster, rosterQuery, targetOf, type GitHubPeopleTarget } from './github-people-query'

export const ROSTER_TIMEOUT_MS = 10_000

export type RosterRun = (args: string[]) => Promise<string>

// No retries (`idempotent: false`): one logical call for the whole app run.
const ghRun: RosterRun = async (args) => {
  try {
    const { stdout } = await ghExecFileAsync(args, {
      encoding: 'utf-8',
      host: 'github.com',
      idempotent: false,
      timeout: ROSTER_TIMEOUT_MS
    })
    return stdout
  } catch (error) {
    // A GraphQL error on one source exits non-zero but still prints the others' data.
    return extractExecError(error).stdout
  }
}

export class GitHubPeopleRosters {
  /** The app run's one read, once a request has started it. */
  private once: Promise<BotGitHubRoster> | null = null

  constructor(
    private readonly run: RosterRun = ghRun,
    private readonly now: () => number = Date.now
  ) {}

  /** `owner`: the asking picker's linked GitHub login, recorded with the read it starts. */
  read(scope: GitHubPeopleScope, owner: string | null): Promise<BotGitHubRoster> {
    if (this.once) {
      // Later requests share the one read; a settled read says it was reused.
      return this.once.then((roster) =>
        roster.status === 'read' ? { ...roster, reused: true } : roster
      )
    }
    const { target, dropped } = targetOf(scope)
    if (target.repositories.length + target.owners.length === 0) {
      // Nothing readable to ask for: no gh runs, so no read is spent.
      return Promise.resolve({ status: 'unavailable' })
    }
    this.once = this.readNow(target, dropped || scope.more, { scope, owner })
    return this.once
  }

  private async readNow(
    target: GitHubPeopleTarget,
    omitted: boolean,
    readFor: { scope: GitHubPeopleScope; owner: string | null }
  ): Promise<BotGitHubRoster> {
    const built = rosterQuery(target)
    const args = ['api', 'graphql', '-f', `query=${built.document}`]
    for (const [key, value] of Object.entries(built.vars)) {
      args.push('-f', `${key}=${value}`)
    }
    const readAt = this.now()
    const stdout = await this.run(args).catch(() => '')
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
      readAt,
      reused: false,
      readFor,
      ...(read.viewer ? { searchedAs: read.viewer } : {})
    }
  }
}

let shared: GitHubPeopleRosters | null = null
/** The host's one read for this app run. */
export function gitHubPeopleRosters(): GitHubPeopleRosters {
  shared ??= new GitHubPeopleRosters()
  return shared
}
