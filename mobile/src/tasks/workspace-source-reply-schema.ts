import { z } from 'zod'
import type { SshConnectionStatus } from '../../../src/shared/ssh-types'
import {
  hostUnionArms,
  openEnum,
  salvagedOptional,
  salvagingArray
} from '../../../src/shared/zod-salvage'

// The repo and SSH reads the workspace-create drawer runs. Checked against
// src/main/runtime/rpc/methods/ssh.ts:30-46 (getPublicSshState, SshConnectionState in
// src/shared/ssh-types.ts:187), src/main/runtime/rpc/methods/preflight.ts:22-30 (both agent probes
// answer a bare `string[]`), and repo.ts:87-103/:184-192 (the sparse preset envelopes, the ref
// search and the orca.yaml hooks).

// Pinned to the host's own union through hostUnionArms: an arm added or dropped host-side fails tsc.
export const SSH_CONNECTION_STATUS = hostUnionArms<SshConnectionStatus>({
  disconnected: true,
  connecting: true,
  'auth-failed': true,
  'deploying-relay': true,
  connected: true,
  reconnecting: true,
  'reconnection-failed': true,
  error: true
})

const sourceText = (name: string) => salvagedOptional(name, z.string())

/**
 * The SSH connection record, answered under a `state` member by both `ssh.connect` and
 * `ssh.getState`.
 *
 * Only `targetId` and `status` are required, and only those two are read: the gate matches
 * `state.targetId` against the repo's connection id and tests `state.status`
 * (workspace-ssh-gate.ts:58-60). `error` is read as `matchingState?.error ?? null` (:65), already
 * guarded and null-collapsed, and nothing anywhere reads `reconnectAttempt`.
 *
 * They are optional rather than required BECAUSE nothing reads them. `state` is a
 * `salvagedOptional`, so one bad member drops the whole record, and the connect path's fallback for
 * a dropped record is `fallbackSshState(connectionId, 'connected', null)`
 * (use-new-workspace-execution-target.ts:126) — a reply of
 * `{ targetId, status: 'auth-failed', error: 'bad key' }` with `reconnectAttempt` omitted would
 * show the drawer as CONNECTED. Requiring a member no reader touches converts a partial record into
 * the most dangerous verdict this schema can reach, so the two unread members degrade individually
 * and the record survives with the status it came with.
 *
 * `status` is an OPEN enum whose eight arms are SshConnectionStatus verbatim, arm for arm
 * (src/shared/ssh-types.ts:167-175), so nothing the current host can send degrades at all. It is a
 * wire surface (remote-wire-compatibility.md rule 4), so an arm a newer host adds must not refuse
 * the record or drop it; it degrades to `'disconnected'`.
 *
 * That degrade is allowed only because it is invisible to every reader of `status`. Main passed an
 * unknown arm through as a raw string, and the one function that turns it into text,
 * workspaceSshStatusLabel, falls through to `return 'Disconnected'` (workspace-ssh-gate.ts:50) —
 * the same label the degraded value produces. isWorkspaceSshConnectInProgress (:24-:26) answers false
 * for both, the readiness gate is an equality test against `'connected'`
 * (use-mobile-tasks-workspace-ssh-state.tsx:88/:97, use-new-workspace-execution-target.ts:50)
 * which both fail, and `error` is read off the record untouched. The parity is pinned in
 * workspace-source-reply-schema.test.ts rather than argued here.
 *
 * The whole member stays nullable and optional because that is what the two call sites read:
 * `state ?? fallback…` at use-new-workspace-execution-target.ts:66 and :126.
 *
 * `providerEpoch`, `supportsFolderDownload` and `remotePlatform` are NOT declared. No mobile code
 * reads any of the three; the file-mutation owner check asks ssh.getState through a reader of its
 * own (src/files/mobile-file-ownership-operations.ts:24), not this one. The loose object forwards
 * them verbatim either way. Listing a member ahead of its reader is how a schema starts refusing
 * replies no consumer would have noticed.
 */
export const sshConnectionStateSchema = z
  .looseObject({
    state: salvagedOptional(
      'state',
      z
        .looseObject({
          targetId: z.string(),
          status: openEnum(SSH_CONNECTION_STATUS, 'disconnected'),
          error: salvagedOptional('error', z.string().nullable()),
          reconnectAttempt: salvagedOptional('reconnectAttempt', z.number()),
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
 * (use-mobile-tasks-workspace-ssh-state.tsx:131, use-new-workspace-execution-target.ts:99), so a
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
 * `id`, `name` and `directories` are required, and all three are read with no guard:
 * `id` selects and dedupes (use-mobile-tasks-workspace-sparse-actions.tsx:93/:98), `name` is sorted
 * with `left.name.localeCompare(right.name)` (mobile-tasks-project-workspace-types.ts:127) and
 * lowercased in the drawer (use-mobile-tasks-workspace-create-projection.tsx:118), and
 * `directories` is joined twice (mobile-tasks-workspace-option-pickers.tsx:171,
 * use-mobile-tasks-workspace-sparse-actions.tsx:60). All three are non-optional on SparsePreset
 * (src/shared/worktree/create-types.ts:82-89) and all three are in the recorded preset. A row
 * missing one drops out of the list instead of throwing inside a `useMemo`.
 *
 * The sort is worth naming: `Array.prototype.sort` skips the comparator on a one-element array, so
 * a single bad preset renders fine and two do not.
 *
 * `repoId`, `createdAt` and `updatedAt` are declared non-optional by SparsePreset but absent from
 * the recorded preset (`tw-workspace-source-presets`,
 * `{ id: 'p1', name: 'docs', directories: ['docs'] }`), so they are typed and optional —
 * defaulting them would put numbers in the drawer's recorded state that main never had.
 */
const sparsePreset = z.looseObject({
  id: z.string(),
  name: z.string(),
  directories: salvagingArray(z.string()),
  repoId: sourceText('repoId'),
  createdAt: salvagedOptional('createdAt', z.number()),
  updatedAt: salvagedOptional('updatedAt', z.number())
})

/**
 * The preset list, answered under `presets`. Required, because
 * use-mobile-tasks-workspace-source-effects.tsx:62 reads `presets.some(...)` off whatever the
 * member read answered.
 *
 * What a refusal does here is worth stating plainly, because "reports the named error" overstates
 * it: the error goes to `setWorkspaceSparsePresetsError`, whose value is destructured as
 * `_workspaceSparsePresetsError` (use-mobile-tasks-workspace-and-project-state.tsx:57) and read by
 * nobody, on this branch and on main alike. The only visible effect is `presetsLoaded` staying
 * false, which disables "New preset" (mobile-tasks-workspace-option-pickers.tsx:190/:194) and both
 * draft entry points (use-mobile-tasks-workspace-sparse-actions.tsx:34/:51). Main set
 * `presetsLoaded: true` over an empty list and let the user create one. No shipped host reaches
 * that state: `repo.sparsePresets` has no refusal arm and answers
 * `{ presets: await runtime.listSparsePresets(...) }` unconditionally
 * (src/main/runtime/rpc/methods/repo.ts:87-91).
 */
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
