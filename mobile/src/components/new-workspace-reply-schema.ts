import { z } from 'zod'
import type { SetupRunPolicy } from '../../../src/shared/orca-yaml-hook-types'
import { hostUnionArms, salvagedOptional, salvagingRecord } from '../../../src/shared/zod-salvage'

// Schemas match runtime repo.hooks/getRepoHooks and client-ui ui.get ({ui} envelope).

// Pinned to the host's own union through hostUnionArms: an arm added or dropped host-side fails tsc.
export const SETUP_RUN_POLICIES = hostUnionArms<SetupRunPolicy>({
  ask: true,
  'run-by-default': true,
  'skip-by-default': true
})

// Require nullable source because SetupHookDetails reads it without guard; host explicitly sends null for absent orca.yaml.
// Keep hooks nullable for binary/unparsable YAML. Salvage unknown policy to existing run-by-default fallback; host union arms stay type-pinned.
// setupTrust is optional+nullable because real components-setup-ask normal reply carries null; do not count it as dropped member.
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
  setupRunPolicy: salvagedOptional('setupRunPolicy', z.enum(SETUP_RUN_POLICIES)),
  setupConfig: salvagedOptional('setupConfig', z.looseObject({ command: z.string() }).nullable()),
  setupTrust: salvagedOptional(
    'setupTrust',
    z.looseObject({ contentHash: z.string(), scriptContent: z.string() }).nullable()
  )
})

// Salvage malformed approvals per repo, failing closed without rejecting whole reply; pass unknown entries through because ui.set writes blob back.
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

// Total ui.get reader preserves optional trust default for every shape: unawaited caller has no catch, so throwing would also skip available-provider setup.
// Salvage per repo so one malformed approval cannot erase other trust. Unit test covers fulfilled non-object payload outside matrix mutation vocabulary.
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
  .catch(undefined)
  .transform((reply) => reply?.ui)
