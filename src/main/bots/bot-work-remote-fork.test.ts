import { describe, expect, it, vi } from 'vitest'
import { botWorkHasPrBranch, type BotWorkRows } from './bot-work-pr-branch'
import { readRemoteGitHubRepo, type BotWorkRemoteRuntime } from './bot-work-remote-workspace'
import type { BotWorkRow } from './bot-work-store'
import type { BotWorkWorker } from './bot-work-types'
import { ownPullRequestOf } from '../connector-cloud/own-pr-trigger-guard'
import type * as GitRunnerModule from '../git/command-runner/hosted-cli/gh-exec-file'

const { ghExecFileAsync } = vi.hoisted(() => ({ ghExecFileAsync: vi.fn() }))
vi.mock('../git/command-runner/hosted-cli/gh-exec-file', async (importOriginal) => ({
  ...(await importOriginal<typeof GitRunnerModule>()),
  ghExecFileAsync
}))

// This machine's GitHub gives each repository its id.
const IDS: Record<string, string> = { 'repos/owner/fork': '999', 'repos/acme/web': '777' }
ghExecFileAsync.mockImplementation(async (args: string[]) => ({
  stdout: `${IDS[args[1]!] ?? ''}\n`,
  stderr: ''
}))

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the reads use only these worker fields.
const worker = {
  dispatchId: 'ctx_remote',
  host: 'env-1',
  worktreeId: 'repo-s::/srv/fix'
} as BotWorkWorker

// A paired server whose worker has fix-login checked out in a clone of owner/fork.
function server(): BotWorkRemoteRuntime {
  const answers: Record<string, unknown> = {
    'worktree.show': { worktree: { repoId: 'repo-s', branch: 'refs/heads/fix-login', head: 'a1' } },
    'github.repoSlug': { owner: 'owner', repo: 'fork' }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the reads use only these runtime members.
  return {
    getOrchestrationDb: () => ({
      getFederatedDispatch: () => ({ environment_id: 'env-1', peer_fingerprint: 'peer' })
    }),
    resolveOrchestrationWorkerServer: () => ({
      environmentId: 'env-1',
      peerFingerprint: 'peer',
      pairingRevision: 1
    }),
    callOrchestrationWorkerServer: async (_env: string, method: string) => answers[method]
  } as unknown as BotWorkRemoteRuntime
}

function rows(runtime: BotWorkRemoteRuntime): BotWorkRows {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: botWorkHasPrBranch passes the row back untouched.
  const row = { rowId: 'row-1' } as BotWorkRow
  return {
    rows: () => [row],
    workspace: async () => ({
      branch: 'refs/heads/fix-login',
      githubRepo: () => readRemoteGitHubRepo(runtime, worker)
    })
  }
}

/** The owner's pull request into acme/web from fix-login, its head in the repository with this id. */
function forkPr(headRepoId: string) {
  const pr = ownPullRequestOf(
    { source: 'github', event: 'pr_opened', fromOwner: true, place: 'acme/web' },
    {
      event: {
        key: 'pr:5:opened',
        occurredAt: 1,
        actorId: '100',
        fromOwner: true,
        pr: { repoId: '777', number: 5, headRef: 'fix-login', headSha: 'a'.repeat(40), headRepoId }
      }
    }
  )
  if (!pr || pr === 'unknown') {
    throw new Error('not an own pull request')
  }
  return pr
}

describe("a paired server worker's fork pull request", () => {
  it("is the bot's when its fork is the head, matched by the id this machine reads for its name", async () => {
    expect(await botWorkHasPrBranch(rows(server()), forkPr('999'))).toBe(true)
  })

  it("is not the bot's from another fork with the same branch", async () => {
    expect(await botWorkHasPrBranch(rows(server()), forkPr('888'))).toBe(false)
  })
})
