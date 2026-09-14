import type { MountAdapter } from './recording-scenario'
import { operationModuleLoader } from './operation-module-loader'

const WORKTREE = 'repo42::/p'

const STATUS_WITH_STAGED_CHANGE = {
  branch: 'feature',
  head: 'abc1234',
  entries: [{ path: 'src/app.ts', status: 'modified', area: 'staged' }],
  upstreamStatus: { ahead: 1, behind: 0, hasUpstream: true }
}

/** Hosted-review create: the mutation chain (status, stage, commit, push, create, link). */
export function hostedReviewMountAdapters(
  modules: ReturnType<typeof operationModuleLoader>
): Record<string, MountAdapter> {
  return {
    'source-control.review-git-preparation': ({ client }) => {
      const preparation = modules.load<
        typeof import('../../source-control/mobile-hosted-review-git-preparation')
      >('mobile/src/source-control/mobile-hosted-review-git-preparation.ts')
      let status: unknown = 'unread'
      let committed: unknown = 'uncommitted'
      return {
        action(name) {
          if (name === 'commit') {
            return preparation
              .commitMobileHostedReviewStagedChanges(client, WORKTREE, 'recorded message')
              .then((value) => {
                committed = value
                return value
              })
          }
          return preparation.readMobileHostedReviewGitStatus(client, WORKTREE).then((value) => {
            status = value
            return value
          })
        },
        state: () => ({ status, committed }),
        dispose: () => {}
      }
    },
    'source-control.remote-prerequisite': (context) => {
      const apply = modules.load<
        typeof import('../../source-control/mobile-hosted-review-remote-prerequisite')
      >(
        'mobile/src/source-control/mobile-hosted-review-remote-prerequisite.ts'
      ).applyMobileHostedReviewRemotePrerequisite
      let outcome: unknown = 'unapplied'
      return {
        action(name, args) {
          const patchEquivalent = args.patchEquivalent === true
          return apply(
            context.client,
            WORKTREE,
            // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the scenario supplies the blocked reason as JSON, not as a typed prefill.
            { blockedReason: args.blockedReason } as Parameters<typeof apply>[2],
            {
              // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the prerequisite reads only upstreamStatus off the status.
              status: {
                entries: [],
                upstreamStatus: { behindCommitsArePatchEquivalent: patchEquivalent }
              } as unknown as Parameters<typeof apply>[3]['status'],
              onProgress: (progress) => context.effect('progress', progress)
            }
          ).then((value) => {
            outcome = value
            return value
          })
        },
        state: () => ({ outcome }),
        dispose: () => {}
      }
    },
    'source-control.hosted-review-eligibility': ({ client }) => {
      const service = modules.load<
        typeof import('../../source-control/mobile-hosted-review-service')
      >('mobile/src/source-control/mobile-hosted-review-service.ts')
      let eligibility: unknown = 'unfetched'
      let prefill: unknown = 'unresolved'
      return {
        action(name) {
          if (name === 'prefill') {
            return service
              .resolveMobileHostedReviewPrefill(client, WORKTREE, {
                branch: 'feature',
                title: 'Recorded title'
              })
              .then((value) => {
                prefill = value
                return value
              })
          }
          return service
            .fetchMobileHostedReviewEligibility(client, WORKTREE, { branch: 'feature' })
            .then((value) => {
              eligibility = value
              return value
            })
        },
        state: () => ({ eligibility, prefill }),
        dispose: () => {}
      }
    },
    'source-control.hosted-review-create': ({ client }) => {
      const create = modules.load<
        typeof import('../../source-control/mobile-hosted-review-service')
      >('mobile/src/source-control/mobile-hosted-review-service.ts').createMobileHostedReview
      let outcome: unknown = 'uncreated'
      return {
        action: (_name, args) =>
          create(client, WORKTREE, {
            provider: 'github',
            base: 'main',
            head: 'feature',
            title: 'Recorded title',
            body: 'Recorded body',
            draft: false,
            pushBeforeCreate: args.pushBeforeCreate === true
          }).then((value) => {
            outcome = value
            return value
          }),
        state: () => ({ outcome }),
        dispose: () => {}
      }
    },
    'source-control.create-intent': (context) => {
      const run = modules.load<
        typeof import('../../source-control/mobile-hosted-review-create-intent-runner')
      >(
        'mobile/src/source-control/mobile-hosted-review-create-intent-runner.ts'
      ).runMobileHostedReviewCreateIntent
      let outcome: unknown = 'unrun'
      return {
        action: (_name, args) =>
          run(context.client, WORKTREE, {
            branch: 'feature',
            title: 'Recorded title',
            ...(args.commitMessage === undefined
              ? {}
              : { commitMessage: String(args.commitMessage) }),
            // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the seed status is scenario data, not a validated host payload.
            status: STATUS_WITH_STAGED_CHANGE as unknown as Parameters<typeof run>[2]['status'],
            onProgress: (progress) => context.effect('progress', progress)
          }).then((value) => {
            outcome = value
            return value
          }),
        state: () => ({ outcome }),
        dispose: () => {}
      }
    }
  }
}
