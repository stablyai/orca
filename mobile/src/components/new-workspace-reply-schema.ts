import { z } from 'zod'
import { salvagedOptional, salvagingRecord } from '../../../src/shared/zod-salvage'

// The New Workspace drawer's own two reads. Checked against `repo.hooks`
// (src/main/runtime/rpc/methods/repo.ts:190 → runtime.getRepoHooks) and `ui.get`
// (src/main/runtime/rpc/methods/client-ui.ts:60), which answers `{ ui }` and nothing else.

/**
 * The repo's setup hook, as the drawer decorates its advanced section with it.
 *
 * `source` is the one required member: use-new-workspace-setup-script.ts:51 assigns it straight
 * into `SetupHookDetails.source`, whose type is `string | null`, with no guard in between — and the
 * handler always answers it, `null` when no orca.yaml parsed. Nullable rather than optional so the
 * "no hooks file" answer keeps its explicit `null` instead of collapsing to absent.
 *
 * Everything else keeps main's own guards behind it. `hooks` is read through
 * `result.hooks?.scripts?.setup?.trim()` and stays nullable, because the handler returns `null`
 * there for a binary or unparsable orca.yaml. `setupRunPolicy` is a closed enum with the call
 * site's `?? 'run-by-default'` still doing the defaulting: the only two comparisons against it are
 * `!== 'skip-by-default'` and `=== 'ask'`, so an arm this build does not know behaves exactly as
 * main's unrecognised string did. The arms are the host's `SetupRunPolicy`
 * (src/shared/orca-yaml-hook-types.ts:1), which is what `getEffectiveSetupRunPolicy` answers. `setupTrust` is nullable as well as optional because the
 * `components-setup-ask` fixture sends an explicit `null` — salvaging that as a drop would move a
 * `normal` golden for a reply the host really sends.
 */
export const newWorkspaceRepoHooksSchema = z.looseObject({
  hooks: salvagedOptional(
    'hooks',
    z
      .looseObject({
        scripts: salvagedOptional(
          'scripts',
          z.looseObject({ setup: salvagedOptional('setup', z.string()) })
        )
      })
      .nullable()
  ),
  source: z.string().nullable(),
  setupRunPolicy: salvagedOptional(
    'setupRunPolicy',
    z.enum(['ask', 'run-by-default', 'skip-by-default'])
  ),
  setupTrust: salvagedOptional(
    'setupTrust',
    z.looseObject({ contentHash: z.string(), scriptContent: z.string() }).nullable()
  )
})

// One approval inside the persisted trust record. Both members are required *inside* a
// `salvagedOptional`, so a malformed approval drops to absent rather than failing the reply — and an
// approval that cannot be read is not an approval, which is the fail-closed direction for a trust
// record. Entries this build does not know pass through, because `ui.set` writes the blob back.
const trustedOrcaHookApprovalSchema = z.looseObject({
  contentHash: z.string(),
  approvedAt: z.number()
})

const trustedOrcaHookRepoSchema = z.looseObject({
  all: salvagedOptional('all', z.looseObject({ approvedAt: z.number() })),
  setup: salvagedOptional('setup', trustedOrcaHookApprovalSchema),
  archive: salvagedOptional('archive', trustedOrcaHookApprovalSchema),
  issueCommand: salvagedOptional('issueCommand', trustedOrcaHookApprovalSchema),
  vmRecipe: salvagedOptional('vmRecipe', trustedOrcaHookApprovalSchema)
})

/**
 * The persisted UI state, read for the trusted-hooks record alone.
 *
 * Nullish at both levels because the drawer always read it that way: main's reader answered
 * `undefined` for a null result rather than throwing on it, and
 * use-new-workspace-runtime-context.ts:80 takes `ui.value?.trustedOrcaHooks ?? {}`. The record
 * salvages per repo, so one unreadable repo's approvals cannot cost every other repo its trust.
 */
export const newWorkspaceUiTrustSchema = z
  .looseObject({
    ui: salvagedOptional(
      'ui',
      z
        .looseObject({
          trustedOrcaHooks: salvagedOptional(
            'trustedOrcaHooks',
            salvagingRecord(z.string(), trustedOrcaHookRepoSchema)
          )
        })
        .nullable()
    )
  })
  .nullish()
  .transform((reply) => reply?.ui)
