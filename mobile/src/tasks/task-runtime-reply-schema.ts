import { z } from 'zod'
import { salvagedOptional, salvagingArray } from '../../../src/shared/zod-salvage'

// What the Tasks screen reads once per host to hydrate, and the preferences it writes back.
// Checked against src/main/runtime/rpc/methods/status.ts:6-16 (RuntimeStatus, declared in
// src/shared/runtime-session-contracts.ts:64), client-ui.ts:22-74 (the `{ settings }` / `{ ui }`
// envelopes), preflight.ts:17 (PreflightStatus) and linear.ts:35-42 (the connection status).

/**
 * The runtime status, read for a capability list and nothing else.
 *
 * `capabilities` is the only member any consumer here reaches for, and every one of them guards it
 * — `status.capabilities?.includes(…)` in use-mobile-tasks-runtime-hydration.tsx:205 and in
 * src/shared/file-mutation-ownership.ts:10, `result.capabilities ?? []` in
 * worktree-create-capability.ts:51. So the requirement is the container: main read `.capabilities`
 * off whatever the payload was, and a string or a number reply was a property read that answered
 * `undefined` and silently downgraded the host to "Tasks unsupported".
 *
 * Elements are strings and a non-string element drops. `includes` over a mixed array already never
 * matched a capability id, so the drop changes no verdict; it is what makes the drop visible in
 * the salvage report instead of invisible in an `includes` that quietly answers false.
 *
 * `worktreeCreateIdempotency` is `unknown` on purpose. worktree-create-capability.ts:55-70 does its
 * own `typeof`/`Array.isArray` triage over it and treats absent, null, non-object and object as
 * four different answers; a schema that narrowed it would have to pick one of those apart here and
 * change which branch a host lands in.
 */
export const taskRuntimeStatusSchema = z.looseObject({
  capabilities: salvagedOptional('capabilities', salvagingArray(z.string())),
  worktreeCreateIdempotency: z.unknown().optional(),
  hostPlatform: salvagedOptional('hostPlatform', z.string())
})

/**
 * Persisted client UI state, answered under a `ui` member.
 *
 * The reader yields `ui` itself, which is what the member reader it replaces did. Main's
 * `rpcPayloadMember` threw on a null or absent payload and read `undefined` off anything else, so
 * the container is the requirement and every member under it stays optional: :283 spells
 * `uiState?.trustedOrcaHooks ?? {}` and :284 `uiState?.taskResumeState ?? {}`.
 *
 * Both members are `unknown`, and the call site keeps one narrowing cast over them. They are
 * opaque forwards: `trustedOrcaHooks` goes straight into state, and `taskResumeState` is the
 * screen's whole persisted view state, re-read field by field with its own defaults at :286 and
 * across use-mobile-tasks-client-settings-actions.tsx. Declaring either here would restate a
 * twelve-member union that nothing in this reader reads.
 */
export const taskUiStateSchema = z
  .looseObject({
    ui: salvagedOptional(
      'ui',
      z.looseObject({
        taskResumeState: z.unknown().optional(),
        trustedOrcaHooks: z.unknown().optional()
      })
    )
  })
  .transform((reply) => reply.ui)

/**
 * The provider preflight, read only for whether `glab` is installed.
 *
 * Three consumers and all three guard to the leaf: `preflight?.glab?.installed === true`
 * (use-mobile-tasks-runtime-hydration.tsx:295, mobile-home-host-requests.ts:95) and the
 * `readProbeMember` pair in use-new-workspace-runtime-context.ts:92. `git` and `gh` are declared
 * non-optional by PreflightStatus but no mobile consumer reads them, so they pass through.
 */
export const taskPreflightSchema = z.looseObject({
  glab: salvagedOptional(
    'glab',
    z.looseObject({ installed: salvagedOptional('installed', z.boolean()) })
  )
})

/**
 * Whether Linear is connected.
 *
 * `connected` is compared to `true` at use-mobile-tasks-runtime-hydration.tsx:293,
 * mobile-home-host-requests.ts:96 and use-new-workspace-runtime-context.ts:96, so absence and
 * `false` already mean the same thing and nothing is required. `workspaces` is not declared: the
 * picker reads it through a different operation on this same method, and listing a member ahead of
 * a reader is how a schema starts refusing replies no consumer here would have noticed.
 */
export const taskLinearStatusSchema = z.looseObject({
  connected: salvagedOptional('connected', z.boolean())
})

/**
 * The three writes whose reply body no call site reads.
 *
 * `ui.set` is interpreted for its verdict alone and the value discarded
 * (use-mobile-tasks-client-settings-actions.tsx:201, setup-hook-trust.ts:49-51); `settings.update` is
 * fire-and-forget at five sites and never interpreted; `linear.selectWorkspace` chains the context
 * reload off the send without interpreting it. Declaring a member on any of them would be a
 * requirement with no reader, and would make a refusal visible for the first time at a site whose
 * whole documented behaviour is that it is not.
 */
export const taskPreferenceWriteSchema = z.unknown()
