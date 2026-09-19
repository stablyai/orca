import { bindDeferredRpcOperation, defineRpcOperation } from '../transport/rpc-operation'
import { rpcResultVariant } from '../transport/rpc-operation-result-reader'
import {
  hostPlatformSchema,
  hostProjectGroupListSchema,
  hostRepoCatalogSchema,
  hostScreenUnreadReplySchema,
  hostSshTargetSummariesSchema,
  hostViewSettingsSchema
} from './host-screen-reply-schema'

// What the host screen reads to label its rows and to mirror the desktop's workspace view store.
// Every read here is decorative: a refusal leaves the screen on what it already has and the next
// refresh retries, so all of them skip rather than throw.
//
// A skip's reader runs only on a reply the policy already admitted, so an unreadable one throws
// rather than skipping. Both readers that project a list are inside the metadata refresh's own
// try/catch, which already treats a failed refresh as "retry on the next one"; the four writes read
// no reply body at all. host-screen-reply-schema.ts says which members each screen actually reads.

export const hostRepoCatalogRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'repo.host-catalog-or-skip',
    method: 'repo.list',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('repo-catalog', hostRepoCatalogSchema)
  })
)

/** Desktop sidebar groups. Skip on a host that predates the method. */
export const hostProjectGroupListRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'projectGroup.host-catalog-or-skip',
    method: 'projectGroup.list',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('project-group-catalog', hostProjectGroupListSchema)
  })
)

/** Row labels for a catalog that spans hosts. Absent on a host that predates the method. */
export const hostSshTargetSummariesRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'ssh.host-target-summaries-or-skip',
    method: 'ssh.listTargetSummaries',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('ssh-target-summaries', hostSshTargetSummariesSchema)
  })
)

export const hostPlatformRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'host.platform-or-skip',
    method: 'host.platform',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('host-platform', hostPlatformSchema)
  })
)

/**
 * The desktop's shared workspace view settings, a third family on ui.get.
 *
 * It keeps the Tasks screen's property-read throw on a null result — the screen's own try/catch is
 * what that throw has always landed in — where the New Workspace drawer's reader degrades instead.
 */
export const hostViewSettingsRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'ui.host-view-settings-or-skip',
    method: 'ui.get',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('ui-view-settings', hostViewSettingsSchema)
  })
)

/** Patching the same store. Best-effort: the local state already moved, and no reply is read. */
export const hostViewSettingsWrite = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'ui.set-host-view-settings-or-skip',
    method: 'ui.set',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('ui-view-settings-written', hostScreenUnreadReplySchema)
  })
)

/**
 * The host list's three row mutations.
 *
 * All three skip on refusal, which is not the policy `worktree.set-review-link` uses on the same
 * method in source-control: a review link throws so the composer can report it, where a pin write
 * is optimistic and its `.catch` already swallowed everything. Two policies, both named.
 */
export const worktreePinWrite = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'worktree.set-pinned-or-skip',
    method: 'worktree.set',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('pin-written', hostScreenUnreadReplySchema)
  })
)

/** Deleting a row. Only acceptance is read: a refusal is what puts the row back. */
export const worktreeRemove = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'worktree.remove-or-skip',
    method: 'worktree.rm',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('worktree-removed', hostScreenUnreadReplySchema)
  })
)

/**
 * Telling the host which workspace the phone opened. Best-effort; navigation does not wait.
 *
 * Two readers. The host list sends it and never looks, and the session route's startup effect reads
 * the skip verdict for one thing only: an accepted reply saying the host is headless is what raises
 * the "open Orca on the host" toast. A refusal and a dropped reply both mean "no advice", which is
 * what the skip already says.
 */
export const worktreeActivate = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'worktree.activate-or-skip',
    method: 'worktree.activate',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('worktree-activated', hostScreenUnreadReplySchema)
  })
)
