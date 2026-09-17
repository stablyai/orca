import { z } from 'zod'
import { openEnum, salvagedOptional, salvagingArray } from '../../../src/shared/zod-salvage'

// The repo and SSH reads the workspace-create drawer runs. Checked against
// src/main/runtime/rpc/methods/ssh.ts:30-46 (getPublicSshState, SshConnectionState in
// src/shared/ssh-types.ts:187), preflight.ts:22-30 (both agent probes answer a bare `string[]`),
// and repo.ts:87-103/:184-192 (the sparse preset envelopes, the ref search and the orca.yaml
// hooks).

const SSH_CONNECTION_STATUS = [
  'disconnected',
  'connecting',
  'auth-failed',
  'deploying-relay',
  'connected',
  'reconnecting',
  'reconnection-failed',
  'error'
] as const

const sourceText = (name: string) => salvagedOptional(name, z.string())

/**
 * The SSH connection record, answered under a `state` member by both `ssh.connect` and
 * `ssh.getState`.
 *
 * All four members SshConnectionState declares are required, and every recorded reply carries
 * them (`tw-workspace-ssh-connected`, `tw-workspace-ssh-not-ready`, `tw-workspace-sparse-saved`,
 * `files-ownership-ssh`). They have to be: the drawer publishes the record into state and renders
 * it, and `error` is a tri-state the UI shows — `null` means "connected cleanly", a string is the
 * failure text, and the two are not interchangeable.
 *
 * `status` is an OPEN enum. It is a wire surface (remote-wire-compatibility.md rule 4), so an arm
 * this build has not heard of must not refuse the record or drop it. It degrades to
 * `'disconnected'`, which is main's own answer for a state it did not receive
 * (use-new-workspace-execution-target.ts:63, use-mobile-tasks-workspace-sparse-actions.tsx:144):
 * the readiness gate is an equality test against `'connected'`, so the degrade never grants a
 * create it should not, and it leaves the Connect affordance the user needs.
 *
 * The whole member stays nullable and optional because that is what the two call sites read:
 * `state ?? fallback…` at use-mobile-tasks-workspace-ssh-state.tsx:62 and :96.
 *
 * `providerEpoch`, `supportsFolderDownload` and `remotePlatform` are NOT declared. Nothing in this
 * domain reads them, and a loose object forwards them to the file-mutation owner check and the
 * download gate exactly as main did — listing a member ahead of its reader is how a schema starts
 * refusing replies no consumer here would have noticed.
 */
export const sshConnectionStateSchema = z
  .looseObject({
    state: salvagedOptional(
      'state',
      z
        .looseObject({
          targetId: z.string(),
          status: openEnum(SSH_CONNECTION_STATUS, 'disconnected'),
          error: z.string().nullable(),
          reconnectAttempt: z.number(),
          connectionGeneration: salvagedOptional('connectionGeneration', z.number())
        })
        .nullable()
    )
  })
  .transform((reply) => reply.state)

/**
 * The agent ids a host reports, local or remote.
 *
 * A bare array of strings, which is what both handlers return. The drawer builds a `Set` from it
 * (use-mobile-tasks-workspace-ssh-state.tsx:131, use-new-workspace-execution-target.ts:96), so a
 * non-iterable payload was a TypeError inside a `.then` and a number reply was a silent
 * `Set { 7 }` that matched no agent. A non-string element drops rather than failing the probe:
 * every reader compares the id to a known agent, so a dropped element and a kept non-string agree
 * on every verdict, and the drop is the one that says so in the salvage report.
 */
export const detectedAgentIdsSchema = salvagingArray(z.string())

/**
 * The repo's orca.yaml hooks.
 *
 * Nothing is required. use-mobile-tasks-workspace-ssh-state.tsx:196 spells
 * `result.hooks?.scripts?.setup?.trim()`, :204 defaults `setupRunPolicy`, and
 * `normalizeSetupHookTrust` rejects a `setupTrust` without both members — and the recorded
 * `tw-workspace-ssh-not-ready` reply is `{ hooks: { scripts: {} } }` with no `source` and no
 * policy at all, so a requirement on either would refuse a reply main handled. `setupTrust` is
 * nullable because `components-setup-ask` records an explicit `null` there.
 *
 * `setupRunPolicy` stays a plain string. :205 tests it against `'ask'` and :209 against
 * `'run-by-default'`, so an unknown policy already lands on the `skip` arm; closing the set would
 * drop it to the schema's fallback instead and change which arm a newer host reaches.
 */
export const repoSetupHooksSchema = z.looseObject({
  hooks: salvagedOptional(
    'hooks',
    z
      .looseObject({
        scripts: salvagedOptional('scripts', z.looseObject({ setup: sourceText('setup') }))
      })
      .nullable()
  ),
  source: salvagedOptional('source', z.string().nullable()),
  setupRunPolicy: sourceText('setupRunPolicy'),
  setupTrust: salvagedOptional(
    'setupTrust',
    z
      .looseObject({
        contentHash: sourceText('contentHash'),
        scriptContent: sourceText('scriptContent')
      })
      .nullable()
  )
})

/**
 * One saved sparse-checkout preset.
 *
 * `id` alone is required: it is what the picker selects by and what the save path dedupes on
 * (use-mobile-tasks-workspace-sparse-actions.tsx:93/:98). `repoId`, `createdAt` and `updatedAt`
 * are declared non-optional by SparsePreset but absent from the recorded preset
 * (`tw-workspace-source-presets`, `{ id: 'p1', name: 'docs', directories: ['docs'] }`), so they
 * are typed and optional — defaulting them would put numbers in the drawer's recorded state that
 * main never had.
 */
const sparsePreset = z.looseObject({
  id: z.string(),
  name: sourceText('name'),
  directories: salvagedOptional('directories', salvagingArray(z.string())),
  repoId: sourceText('repoId'),
  createdAt: salvagedOptional('createdAt', z.number()),
  updatedAt: salvagedOptional('updatedAt', z.number())
})

/** The preset list, answered under `presets`. Required, because use-mobile-tasks-workspace-source-effects.tsx:62 reads `presets.some(...)` off
 *  whatever the member read answered. */
export const repoSparsePresetListSchema = z
  .looseObject({ presets: salvagingArray(sparsePreset) })
  .transform((reply) => reply.presets)

/**
 * The preset a save answers with.
 *
 * Optional, and deliberately: `tw-workspace-sparse-missing-preset` records the host answering
 * `{}`, which main turned into its own "Failed to save sparse preset." error. That path is kept.
 */
export const repoSparsePresetSaveSchema = z
  .looseObject({ preset: salvagedOptional('preset', sparsePreset) })
  .transform((reply) => reply.preset)

/**
 * Base-branch search.
 *
 * Neither member is required: both call sites spell the same
 * `refDetails ?? refs.map(…)` fallback (use-mobile-tasks-workspace-source-effects.tsx:128,
 * smart-source-search-requests.ts:108), and the two recorded replies carry one member each —
 * `{ refs: [...] }` in `tw-workspace-source-presets` and `{ refDetails: [...] }` in
 * `tw-smart-search-gitlab-provider-error`. The fallback stays at the call sites, where it was;
 * what the schema adds is that a `refs` full of numbers no longer reaches the picker as rows
 * whose `refName` renders as a number.
 */
export const repoBaseRefSearchSchema = z.looseObject({
  refs: salvagedOptional('refs', salvagingArray(z.string())),
  refDetails: salvagedOptional(
    'refDetails',
    salvagingArray(z.looseObject({ refName: z.string(), localBranchName: z.string() }))
  )
})
