import type { MountAdapter } from '../recording-scenario'
import type { operationModuleLoader } from '../operation-module-loader'

const WORKTREE = 'repo-9::/w'
const PR_NUMBER = 12
const FORK_REPO = { owner: 'fork-owner', repo: 'fork-repo', host: 'github.enterprise.test' }

/**
 * The PR sidebar's `github.*` surface: seven reads and twelve mutations, all exported async
 * functions taking a client, so no React host is needed and the recorded state is each wrapper's
 * own `{ ok }` outcome. `fork` picks the arm that forwards a `prRepo` slug, which only the
 * allow-listed methods accept.
 */
export function githubPrMountAdapters(
  modules: ReturnType<typeof operationModuleLoader>
): Record<string, MountAdapter> {
  return {
    'session.pr-reads': ({ client }) => {
      const reads = modules.load<typeof import('../../../session/github-pr-rpc')>(
        'mobile/src/session/github-pr-rpc.ts'
      )
      const results: Record<string, unknown> = {}
      function send(name: string, args: Record<string, unknown>): Promise<unknown> {
        const prRepo = args.fork === true ? FORK_REPO : null
        if (name === 'repo-slug') {
          return reads.fetchGithubRepoSlug(client, WORKTREE)
        }
        if (name === 'hosted-review') {
          return reads.fetchHostedReviewForBranch(client, WORKTREE, {
            branch: 'feature',
            linkedGitHubPR: PR_NUMBER
          })
        }
        if (name === 'pr-for-branch') {
          return reads.fetchPRForBranch(client, WORKTREE, { branch: 'feature' })
        }
        if (name === 'work-item') {
          return reads.fetchWorkItemDetails(client, WORKTREE, { prNumber: PR_NUMBER })
        }
        if (name === 'checks') {
          return reads.fetchPRChecks(client, WORKTREE, {
            prNumber: PR_NUMBER,
            headSha: args.headSha === null ? null : 'head-sha-1',
            prRepo
          })
        }
        if (name === 'check-details') {
          return reads.fetchPRCheckDetails(client, WORKTREE, {
            checkRunId: 7,
            checkName: 'build',
            url: null,
            prRepo
          })
        }
        if (name === 'assignable') {
          return reads.fetchAssignableUsers(client, WORKTREE)
        }
        throw new Error(`Unknown pr read action: ${name}`)
      }
      return {
        action: (name, args) =>
          send(name, args).then((value) => {
            results[name] = value
            return value
          }),
        state: () => ({ ...results }),
        dispose: () => {}
      }
    },
    'session.pr-mutations': ({ client }) => {
      const mutations = modules.load<typeof import('../../../session/github-pr-mutations')>(
        'mobile/src/session/github-pr-mutations.ts'
      )
      const results: Record<string, unknown> = {}
      function send(name: string, args: Record<string, unknown>): Promise<unknown> {
        const prRepo = args.fork === true ? FORK_REPO : null
        const slug = { owner: 'owner', repo: 'repo', commentId: 55 }
        if (name === 'merge') {
          return mutations.fetchMergePR(client, WORKTREE, {
            prNumber: PR_NUMBER,
            method: 'squash',
            prRepo
          })
        }
        if (name === 'auto-merge') {
          return mutations.fetchSetPRAutoMerge(client, WORKTREE, {
            prNumber: PR_NUMBER,
            enabled: true,
            prRepo
          })
        }
        if (name === 'close') {
          return mutations.fetchUpdatePRState(client, WORKTREE, {
            prNumber: PR_NUMBER,
            state: 'closed',
            prRepo
          })
        }
        if (name === 'request-reviewers') {
          return mutations.fetchRequestPRReviewers(client, WORKTREE, {
            prNumber: PR_NUMBER,
            reviewers: ['octocat'],
            prRepo
          })
        }
        if (name === 'remove-reviewers') {
          return mutations.fetchRemovePRReviewers(client, WORKTREE, {
            prNumber: PR_NUMBER,
            reviewers: ['octocat'],
            prRepo
          })
        }
        if (name === 'rerun-checks') {
          return mutations.fetchRerunPRChecks(client, WORKTREE, {
            prNumber: PR_NUMBER,
            headSha: 'head-sha-1',
            failedOnly: true,
            prRepo
          })
        }
        if (name === 'reply') {
          return mutations.fetchAddPRReviewCommentReply(client, WORKTREE, {
            prNumber: PR_NUMBER,
            commentId: 55,
            body: 'recorded reply',
            threadId: 'thread-1',
            path: 'src/app.ts',
            line: 3,
            prRepo
          })
        }
        if (name === 'root-comment') {
          return mutations.fetchAddIssueComment(client, WORKTREE, {
            prNumber: PR_NUMBER,
            body: 'recorded comment',
            prRepo
          })
        }
        if (name === 'resolve-thread') {
          return mutations.fetchResolveReviewThread(client, WORKTREE, {
            threadId: 'thread-1',
            resolve: true,
            prRepo
          })
        }
        if (name === 'edit-comment') {
          return mutations.fetchUpdateIssueComment(client, { ...slug, body: 'edited' })
        }
        if (name === 'delete-comment') {
          return mutations.fetchDeleteIssueComment(client, slug)
        }
        if (name === 'title') {
          return mutations.fetchUpdatePRTitle(client, WORKTREE, {
            prNumber: PR_NUMBER,
            title: 'Recorded title',
            prRepo
          })
        }
        throw new Error(`Unknown pr mutation action: ${name}`)
      }
      return {
        action: (name, args) =>
          send(name, args).then((value) => {
            results[name] = value
            return value
          }),
        state: () => ({ ...results }),
        dispose: () => {}
      }
    },
    'session.pr-triage-launch': ({ client }) => {
      const launch = modules.load<typeof import('../../../session/pr-ai-triage-launch')>(
        'mobile/src/session/pr-ai-triage-launch.ts'
      ).launchAgentWithPrompt
      let launched: unknown = 'unlaunched'
      return {
        action: (_name, args) =>
          launch({
            client,
            // A host older than the launch capabilities advertises neither.
            hostCapabilities:
              args.legacyHost === true
                ? []
                : ['agent.launch.v2', 'agent.launch.replay.v1', 'agent.launch.replay-required.v1'],
            worktreeId: WORKTREE,
            actionId: 'fixChecks',
            prompt: String(args.prompt ?? 'Fix the failing checks'),
            launchSource: 'task_page'
          }).then((result) => {
            launched = result
          }),
        state: () => ({ launched }),
        dispose: () => {}
      }
    },
    'session.pr-branch-context': ({ client }) => {
      const context = modules.load<typeof import('../../../session/use-mobile-pr-branch-context')>(
        'mobile/src/session/use-mobile-pr-branch-context.ts'
      )
      let repoContext: unknown = 'unread'
      let identity: unknown = 'unread'
      return {
        action(name) {
          if (name === 'repo-context') {
            return context.loadMobilePrRepoContext(client, WORKTREE).then((value) => {
              repoContext = value
              return value
            })
          }
          if (name === 'identity') {
            return context.loadMobilePrBranchIdentity(client, WORKTREE).then((value) => {
              identity = value
              return value
            })
          }
          throw new Error(`Unknown pr branch context action: ${name}`)
        },
        state: () => ({ repoContext, identity }),
        dispose: () => {}
      }
    }
  }
}
