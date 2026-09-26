import type { MountAdapter } from '../recording-scenario'
import type { operationModuleLoader } from '../operation-module-loader'

const REPO = 'repo-1'
const REPO_SELECTOR = `id:${REPO}`

/**
 * The task workspace-creation senders that are exported async functions taking a client: create and
 * its retry loop, the create-time capability probe, hosted-base resolution, the setup-hook trust
 * write and the Smart source picker's provider reads. No React host is needed, so the recorded
 * state is the function's own answer.
 */
export function taskWorkspaceSenderMountAdapters(
  modules: ReturnType<typeof operationModuleLoader>
): Record<string, MountAdapter> {
  return {
    'tasks.worktree-create-retry': ({ client }) => {
      const create = modules.load<typeof import('../../../tasks/worktree-create-retry')>(
        'mobile/src/tasks/worktree-create-retry.ts'
      ).createWorktreeWithNameRetry
      let outcome: unknown = 'uncreated'
      let minted = 0
      return {
        action: (_name, args) =>
          create({
            client,
            baseName: String(args.name ?? 'kestrel'),
            buildParams: (candidate: string) => ({ repo: REPO_SELECTOR, name: candidate }),
            // A resolved probe, because the create path awaits it before the first send.
            worktreeCreateIdempotency: Promise.resolve(
              args.idempotency === false ? false : { dedupeTtlMs: 60_000 }
            ),
            // The launch route is a create-time decision the caller has already settled, so the
            // scenario turns it on rather than naming an agent: which agent is picked changes only
            // the params, and the arm that matters is `agent.launch` instead of `worktree.create`.
            // `replay: false` keeps the recorded method `agent.launch`; the replay-required route
            // is a different method and would need its own scenario.
            ...(args.agentLaunch === true
              ? { agentLaunch: { agent: 'codex' as const, supported: { replay: false } } }
              : {}),
            ...(args.maxAttempts === undefined ? {} : { maxAttempts: Number(args.maxAttempts) }),
            mintMutationId: () => `mutation-${++minted}`
          }).then((value: unknown) => {
            outcome = value
            return value
          }),
        state: () => ({ outcome }),
        dispose: () => {}
      }
    },
    'tasks.worktree-capabilities': ({ client }) => {
      const read = modules.load<typeof import('../../../tasks/worktree-create-capability')>(
        'mobile/src/tasks/worktree-create-capability.ts'
      ).readNewWorktreeRuntimeCapabilities
      let capabilities: unknown = 'unprobed'
      return {
        action: () =>
          read(client).then((value: unknown) => {
            capabilities = value
            return value
          }),
        state: () => ({ capabilities }),
        dispose: () => {}
      }
    },
    'tasks.composer-hosted-base': ({ client }) => {
      const resolve = modules.load<typeof import('../../../tasks/composer-source-base-resolve')>(
        'mobile/src/tasks/composer-source-base-resolve.ts'
      )
      let prBase: unknown = 'unresolved'
      let mrBase: unknown = 'unresolved'
      return {
        action(name) {
          if (name === 'mr-base') {
            return resolve
              .resolveComposerMrBase({ client, repoId: REPO, mrIid: 7, sourceBranch: 'feature' })
              .then((value: unknown) => {
                mrBase = value
                return value
              })
          }
          return resolve
            .resolveComposerPrBase({ client, repoId: REPO, prNumber: 12, headRefName: 'feature' })
            .then((value: unknown) => {
              prBase = value
              return value
            })
        },
        state: () => ({ prBase, mrBase }),
        dispose: () => {}
      }
    },
    'tasks.setup-hook-trust': ({ client }) => {
      const persist = modules.load<typeof import('../../../tasks/setup-hook-trust')>(
        'mobile/src/tasks/setup-hook-trust.ts'
      ).persistSetupHookTrustApproval
      let trust: unknown = 'unapproved'
      return {
        action: (_name, args) =>
          persist({
            client,
            trust: {},
            repoId: REPO,
            contentHash: 'hash-1',
            alwaysTrust: args.always === true
          }).then((value: unknown) => {
            trust = value
            return value
          }),
        state: () => ({ trust }),
        dispose: () => {}
      }
    },
    'tasks.smart-source-search': ({ client }) => {
      const search = modules.load<typeof import('../../../tasks/smart-source-search-requests')>(
        'mobile/src/tasks/smart-source-search-requests.ts'
      )
      const results: Record<string, unknown> = {}
      return {
        action(name, args) {
          const query = String(args.query ?? 'bug')
          const request =
            name === 'gitlab'
              ? search.searchGitLabItems(client, REPO, query, 'opened')
              : name === 'linear'
                ? search.searchLinearIssues(
                    client,
                    query,
                    args.workspace === null ? null : String(args.workspace ?? 'linear-workspace')
                  )
                : name === 'branches'
                  ? search.searchBranches(client, REPO, query)
                  : search.searchGitHubItems(client, REPO, query)
          return request.then((value: unknown) => {
            results[name] = value
            return value
          })
        },
        state: () => ({ ...results }),
        dispose: () => {}
      }
    },
    'tasks.paste-lookup': ({ client }) => {
      const paste = modules.load<typeof import('../../../tasks/smart-source-paste-intent')>(
        'mobile/src/tasks/smart-source-paste-intent.ts'
      )
      const slugCache = new Map<string, { owner: string; repo: string; host?: string } | null>()
      const repos = [
        { id: REPO, displayName: 'Repo', slug: null },
        { id: 'repo-2', displayName: 'Other', slug: null }
      ]
      const results: Record<string, unknown> = {}
      return {
        action(name) {
          const request =
            name === 'by-number'
              ? paste.lookupGitHubItemByNumber(client, REPO, 12)
              : name === 'by-slug'
                ? paste.lookupGitHubItemByOwnerRepo(
                    client,
                    REPO,
                    { owner: 'owner', repo: 'repo' },
                    12,
                    'issue'
                  )
                : name === 'gitlab-path'
                  ? paste.lookupGitLabItemByPath(client, REPO, {
                      slug: { host: 'gitlab.com', path: 'group/project' },
                      number: 7,
                      type: 'issue'
                    })
                  : paste.findRepoMatchingSlugForPaste(
                      client,
                      repos,
                      { owner: 'owner', repo: 'repo' },
                      slugCache
                    )
          return request.then((value: unknown) => {
            results[name] = value
            return value
          })
        },
        state: () => ({ ...results, cache: [...slugCache] }),
        dispose: () => {}
      }
    }
  }
}
