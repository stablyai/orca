import { bindDeferredRpcOperation, defineRpcOperation } from '../transport/rpc-operation'
import { rpcResultVariant } from '../transport/rpc-operation-result-reader'
import {
  hostPlatformSchema,
  hostRepoCatalogSnapshotSchema,
  hostScreenUnreadReplySchema,
  hostSshTargetSummariesSchema,
  hostViewSettingsSchema,
  worktreeArchiveHookTrustSchema
} from './host-screen-reply-schema'

// Decorative reads skip refusals and retry on refresh; malformed accepted replies throw into the refresh/settings catches. Writes read no body.

// The host screen's repo poll: repeats of an unchanged catalog cost a snapshot id, not every icon.
export const hostRepoCatalogSnapshotRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'repo.host-catalog-snapshot-or-skip',
    method: 'repo.list',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('repo-catalog-snapshot', hostRepoCatalogSnapshotSchema)
  })
)

// Older hosts may lack the cross-host catalog method.
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

// Keep null ui.get results throwing into the host screen’s catch; New Workspace deliberately uses a different, degrading reader.
export const hostViewSettingsRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'ui.host-view-settings-or-skip',
    method: 'ui.get',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('ui-view-settings', hostViewSettingsSchema)
  })
)

// Best-effort: local state already moved and no reply body is read.
export const hostViewSettingsWrite = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'ui.set-host-view-settings-or-skip',
    method: 'ui.set',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('ui-view-settings-written', hostScreenUnreadReplySchema)
  })
)

export const hostCardLayoutWrite = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'settings.update-card-layout-or-skip',
    method: 'settings.update',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('card-layout-written', hostScreenUnreadReplySchema)
  })
)

// Optimistic row writes skip refusals; source-control’s review-link write uses the same method but throws so the composer can report failure.
export const worktreePinWrite = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'worktree.set-pinned-or-skip',
    method: 'worktree.set',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('pin-written', hostScreenUnreadReplySchema)
  })
)

export const worktreeSleep = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'worktree.sleep-or-skip',
    method: 'worktree.sleep',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('worktree-slept', hostScreenUnreadReplySchema)
  })
)

// A refused read leaves the archive hook unverified, so deletion does not run it.
export const worktreeArchiveHookTrustRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'repo.archive-hook-trust-or-skip',
    method: 'repo.hooks',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('archive-hook-trust', worktreeArchiveHookTrustSchema)
  })
)

// Deletion reads acceptance only; refusal restores the row and an archive-hook refusal offers Delete Anyway.
export const worktreeRemove = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'worktree.remove-or-skip',
    method: 'worktree.rm',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('worktree-removed', hostScreenUnreadReplySchema)
  })
)

// Navigation never waits for activation. The host list ignores its reply; session startup inspects accepted headless replies for advice and treats refusal as no advice.
export const worktreeActivate = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'worktree.activate-or-skip',
    method: 'worktree.activate',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('worktree-activated', hostScreenUnreadReplySchema)
  })
)
