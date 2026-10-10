import { describe, expect, it } from 'vitest'
import { _internals } from './legacy-wsl-runtime-auth-drain'
import {
  NEWER_AUTH,
  RETIRED_SESSION,
  SOURCE_AUTH,
  SOURCE_CREDENTIALS,
  TARGET_AUTH,
  TORN_CREDENTIALS,
  isWindows
} from './legacy-wsl-runtime-auth-drain-script-fixtures'
import { runApplyScript } from './legacy-wsl-runtime-auth-drain-script-harness'
import {
  runAbsentLegacyHomeScript,
  runRecoveryScript
} from './legacy-wsl-runtime-auth-drain-recovery-script-harness'

describe.skipIf(isWindows)('legacy WSL auth drain apply script', () => {
  it('distinguishes an absent legacy home from an authless retained home', () => {
    const absent = runAbsentLegacyHomeScript({
      createLegacyHome: false,
      script: _internals.inspectLegacyAuthScript
    })
    const retained = runAbsentLegacyHomeScript({
      createLegacyHome: true,
      script: _internals.inspectLegacyAuthScript
    })

    expect(absent.status).toBe(22)
    expect(retained.status).toBe(21)
  })

  it('resolves an active-home-only legacy layout as retained', () => {
    const outcome = runAbsentLegacyHomeScript({
      activeHomeOnly: true,
      createLegacyHome: true,
      script: _internals.inspectLegacyAuthScript
    })

    expect(outcome.status).toBe(21)
    expect(outcome.markerExists).toBe(false)
  })

  it('does not finalize while an authless legacy home still holds sessions', () => {
    const outcome = runAbsentLegacyHomeScript({
      createLegacyHome: true,
      script: _internals.finalizeAbsentAuthScript
    })

    expect(outcome.status).toBe(47)
    expect(outcome.markerExists).toBe(false)
  })

  it('creates the completion-marker parent when the retired tree never existed', () => {
    const outcome = runAbsentLegacyHomeScript({
      createLegacyHome: false,
      markerParentMissing: true,
      script: _internals.finalizeAbsentAuthScript
    })

    expect(outcome.status).toBe(0)
    expect(outcome.markerExists).toBe(true)
  })

  it('promotes the validated source into the account home', () => {
    const outcome = runApplyScript()
    expect(outcome.targetAuth).toBe(SOURCE_AUTH)
  })

  it('leaves the legacy home untouched while promoting', () => {
    // One-directional: the promote step must never write back to the old home.
    expect(runApplyScript().legacyAuth).toBe(SOURCE_AUTH)
  })

  it('refuses torn bytes and leaves the account home intact', () => {
    // Hash call 1 is the source pre-check; rotating right after it means `cp`
    // reads bytes freshness never judged. Pre-guard, those reached the target.
    const outcome = runApplyScript({ rewriteAfterHashCall: 1 })
    expect(outcome.status).toBe(42)
    expect(outcome.targetAuth).toBe(TARGET_AUTH)
  })

  it('refuses a symlinked live source before the destructive path can retire it', () => {
    const result = runApplyScript({ deleteSource: true, sourceAuthSymlink: true })

    expect(result.status).toBe(46)
    expect(result.legacyAuth).toBe(SOURCE_AUTH)
    expect(result.markerExists).toBe(false)
    expect(result.targetAuth).toBe(TARGET_AUTH)
  })

  it('refuses MCP credentials that changed after host validation', () => {
    const outcome = runApplyScript({
      rewriteAfterHashCall: 2,
      rewriteBytes: TORN_CREDENTIALS,
      rewriteTarget: 'source-credentials',
      sourceCredentials: SOURCE_CREDENTIALS
    })
    expect(outcome.status).toBe(43)
    expect(outcome.targetCredentials).toBeNull()
  })

  it('does not overwrite auth changed after the destination hash check', () => {
    const outcome = runApplyScript({
      rewriteBytes: NEWER_AUTH,
      rewriteAfterHashCall: 4,
      rewriteTarget: 'target-auth'
    })
    expect(outcome.status).toBe(39)
    expect(outcome.targetAuth).toBe(NEWER_AUTH)
  })

  it('keeps the source pending when an unpromoted destination changes before deletion', () => {
    // Hash call 3 is the pinned destination check; the quarantine recheck must
    // observe this in-place rewrite before removing the source.
    const outcome = runApplyScript({
      deleteSource: true,
      promoteAuth: false,
      rewriteAfterHashCall: 3,
      rewriteBytes: NEWER_AUTH,
      rewriteTarget: 'target-auth'
    })

    expect(outcome.status).toBe(45)
    expect(outcome.legacyAuth).toBe(SOURCE_AUTH)
    expect(outcome.targetAuth).toBe(NEWER_AUTH)
    expect(outcome.markerExists).toBe(false)
  })

  it('keeps the source pending when the destination changes after final precommit validation', () => {
    // Hash call 9 validates the independent snapshot. A rewrite immediately
    // afterward races the atomic cutover and must be detected on the old inode.
    const outcome = runApplyScript({
      deleteSource: true,
      promoteAuth: false,
      rewriteAfterHashCall: 9,
      rewriteBytes: NEWER_AUTH,
      rewriteTarget: 'target-auth'
    })

    expect(outcome.status).toBe(45)
    expect(outcome.legacyAuth).toBe(SOURCE_AUTH)
    expect(outcome.targetAuth).toBe(NEWER_AUTH)
    expect(outcome.markerExists).toBe(false)
  })

  it('blocks destination rewrites after the final locked validation', () => {
    // Hash call 12 is the installed read-only destination check. The shim's
    // attempted in-place rewrite must fail before the source is retired.
    const outcome = runApplyScript({
      deleteSource: true,
      promoteAuth: false,
      rewriteAfterHashCall: 12,
      rewriteTarget: 'target-auth'
    })

    expect(outcome.status).toBe(0)
    expect(outcome.legacyAuth).toBeNull()
    expect(outcome.targetAuth).toBe(TARGET_AUTH)
    expect(outcome.markerExists).toBe(true)
  })

  it('recovers the source and destination mode after abrupt interruption', () => {
    const outcome = runApplyScript({ deleteSource: true, killAfterSourceRemoval: true })

    expect(outcome.status).not.toBe(0)
    expect(outcome.legacyAuth).toBe(SOURCE_AUTH)
    expect(outcome.targetAuth).toBe(SOURCE_AUTH)
    expect(outcome.targetMode).toBe(0o600)
    expect(outcome.markerExists).toBe(false)
  })

  it('can unlock the destination after interruption during atomic installation', () => {
    const outcome = runApplyScript({
      deleteSource: true,
      killAfterDestinationInstall: true
    })

    expect(outcome.status).not.toBe(0)
    expect(outcome.legacyAuth).toBe(SOURCE_AUTH)
    expect(outcome.targetAuth).toBe(SOURCE_AUTH)
    expect(outcome.targetMode).toBe(0o600)
    expect(outcome.markerExists).toBe(false)
  })

  it('cleans path metadata when interrupted before destination recovery is linked', () => {
    const outcome = runApplyScript({
      deleteSource: true,
      killBeforeDestinationRecoveryLink: true
    })

    expect(outcome.status).not.toBe(0)
    expect(outcome.legacyAuth).toBe(SOURCE_AUTH)
    expect(outcome.destinationRecoveryAuth).toBeNull()
    expect(outcome.destinationRecoveryPathExists).toBe(false)
    expect(outcome.markerExists).toBe(false)
  })

  it('restores verified source recovery instead of mutable quarantine after a crash', () => {
    const outcome = runApplyScript({
      deleteSource: true,
      killAfterSourceRemoval: true,
      rewriteQuarantineBeforeRecovery: true
    })

    expect(outcome.status).not.toBe(0)
    expect(outcome.legacyAuth).toBe(SOURCE_AUTH)
    expect(outcome.sourceRecoveryAuth).toBeNull()
    expect(outcome.sourceQuarantineAuth).toBe(NEWER_AUTH)
    expect(outcome.markerExists).toBe(false)
  })

  it('retains verified destination recovery when the target inode changed after a crash', () => {
    const outcome = runApplyScript({
      deleteSource: true,
      killAfterSourceRemoval: true,
      replaceTargetBeforeRecovery: true
    })

    expect(outcome.status).not.toBe(0)
    expect(outcome.legacyAuth).toBe(SOURCE_AUTH)
    expect(outcome.targetAuth).toBe(NEWER_AUTH)
    expect(outcome.destinationRecoveryAuth).toBe(SOURCE_AUTH)
    expect(outcome.destinationRecoveryPathExists).toBe(true)
    expect(outcome.markerExists).toBe(false)
  })

  it('preserves a source rewrite that lands before quarantine', () => {
    const outcome = runApplyScript({
      deleteSource: true,
      promoteAuth: false,
      rewriteAfterHashCall: 6,
      rewriteBytes: NEWER_AUTH,
      rewriteTarget: 'source-auth',
      sourceSession: RETIRED_SESSION
    })

    expect(outcome.status).toBe(40)
    expect(outcome.legacyAuth).toBe(NEWER_AUTH)
    expect(outcome.targetSession).toBeNull()
    expect(outcome.markerExists).toBe(false)
  })

  it('bridges retired sessions while a legacy pane still owns the source', () => {
    const outcome = runApplyScript({
      deleteSource: false,
      promoteAuth: false,
      sourceSession: RETIRED_SESSION
    })

    expect(outcome.status).toBe(0)
    expect(outcome.legacyAuth).toBe(SOURCE_AUTH)
    expect(outcome.targetSession).toBe(RETIRED_SESSION)
    expect(outcome.markerExists).toBe(false)
  })

  it('rolls back retained-pane links when source ownership changes during the bridge', () => {
    const outcome = runApplyScript({
      deleteSource: false,
      promoteAuth: false,
      rewriteBytes: NEWER_AUTH,
      rewriteSourceAfterSessionLink: true,
      sourceSession: RETIRED_SESSION
    })

    expect(outcome.status).toBe(40)
    expect(outcome.legacyAuth).toBe(NEWER_AUTH)
    expect(outcome.targetSession).toBeNull()
    expect(outcome.markerExists).toBe(false)
  })

  it('rolls back retained-pane links when destination ownership changes during the bridge', () => {
    const outcome = runApplyScript({
      deleteSource: false,
      promoteAuth: false,
      rewriteBytes: NEWER_AUTH,
      rewriteTargetAfterSessionLink: true,
      sourceSession: RETIRED_SESSION
    })

    expect(outcome.status).toBe(45)
    expect(outcome.legacyAuth).toBe(SOURCE_AUTH)
    expect(outcome.targetAuth).toBe(NEWER_AUTH)
    expect(outcome.targetSession).toBeNull()
    expect(outcome.markerExists).toBe(false)
  })

  it('rolls back retired links when ownership changes during the bridge', () => {
    const outcome = runApplyScript({
      deleteSource: true,
      promoteAuth: false,
      rewriteBytes: NEWER_AUTH,
      rewriteSourceAfterSessionLink: true,
      sourceSession: RETIRED_SESSION
    })

    expect(outcome.status).toBe(40)
    expect(outcome.legacyAuth).toBe(NEWER_AUTH)
    expect(outcome.sourceRecoveryAuth).toBe(SOURCE_AUTH)
    expect(outcome.sourceQuarantineAuth).toBe(SOURCE_AUTH)
    expect(outcome.targetSession).toBeNull()
    expect(outcome.markerExists).toBe(false)
  })

  it('rolls back when an atomic rename replaces the destination during the bridge', () => {
    const outcome = runApplyScript({
      deleteSource: true,
      promoteAuth: false,
      replaceTargetAfterSessionLink: true,
      rewriteBytes: NEWER_AUTH,
      sourceSession: RETIRED_SESSION
    })

    expect(outcome.status).toBe(45)
    expect(outcome.legacyAuth).toBe(SOURCE_AUTH)
    expect(outcome.targetAuth).toBe(NEWER_AUTH)
    expect(outcome.targetSession).toBeNull()
    expect(outcome.markerExists).toBe(false)
  })

  it('retires auth after bridging sessions across guest filesystems', () => {
    const outcome = runApplyScript({
      crossFilesystemBridge: true,
      deleteSource: true,
      promoteAuth: false,
      sourceSession: RETIRED_SESSION
    })

    expect(outcome.status).toBe(0)
    expect(outcome.legacyAuth).toBeNull()
    expect(outcome.targetSession).toBe(RETIRED_SESSION)
    expect(outcome.markerExists).toBe(true)
  })

  it('restores the verified recovery when an open writer mutates the quarantined inode', () => {
    const outcome = runApplyScript({
      deleteSource: true,
      promoteAuth: false,
      rewriteBytes: NEWER_AUTH,
      rewriteQuarantineAfterSessionLink: true,
      sourceSession: RETIRED_SESSION
    })

    expect(outcome.status).toBe(40)
    expect(outcome.legacyAuth).toBe(SOURCE_AUTH)
    expect(outcome.sourceRecoveryAuth).toBeNull()
    expect(outcome.sourceQuarantineAuth).toBe(NEWER_AUTH)
    expect(outcome.targetSession).toBeNull()
    expect(outcome.markerExists).toBe(false)
  })

  it('rolls back a published session link after abrupt interruption', () => {
    const outcome = runApplyScript({
      deleteSource: true,
      killAfterSessionLink: true,
      sourceSession: RETIRED_SESSION
    })

    expect(outcome.status).not.toBe(0)
    expect(outcome.legacyAuth).toBe(SOURCE_AUTH)
    expect(outcome.targetSession).toBeNull()
    expect(outcome.markerExists).toBe(false)
  })

  it('finishes a durable session-link commit after abrupt interruption', () => {
    const outcome = runApplyScript({
      deleteSource: true,
      killDuringSessionCommit: true,
      sourceSession: RETIRED_SESSION
    })

    expect(outcome.status).not.toBe(0)
    expect(outcome.legacyAuth).toBe(SOURCE_AUTH)
    expect(outcome.targetSession).toBe(RETIRED_SESSION)
    expect(outcome.sessionCommitMarkerExists).toBe(false)
    expect(outcome.markerExists).toBe(false)
  })

  it('finishes durable cleanup when inspection finds a committed marker', () => {
    const outcome = runRecoveryScript({
      markerPresent: true,
      script: _internals.inspectLegacyAuthScript
    })

    expect(outcome.status).toBe(20)
    expect(outcome.destinationMode).toBe(0o600)
    expect(outcome.destinationRecoveryExists).toBe(false)
    expect(outcome.destinationRecoveryPathExists).toBe(false)
    expect(outcome.sourceRecoveryExists).toBe(false)
  })

  it('finishes durable cleanup when apply finds a committed marker', () => {
    const outcome = runRecoveryScript({
      markerPresent: true,
      script: _internals.applyLegacyAuthScript
    })

    expect(outcome.status).toBe(0)
    expect(outcome.destinationMode).toBe(0o600)
    expect(outcome.destinationRecoveryExists).toBe(false)
    expect(outcome.destinationRecoveryPathExists).toBe(false)
    expect(outcome.sourceRecoveryExists).toBe(false)
  })

  it('refuses absent-source finalization while a durable recovery copy exists', () => {
    const outcome = runRecoveryScript({
      markerPresent: false,
      script: _internals.finalizeAbsentAuthScript
    })

    expect(outcome.status).toBe(46)
    expect(outcome.sourceAuth).toBe(SOURCE_AUTH)
    expect(outcome.destinationMode).toBe(0o600)
    expect(outcome.destinationRecoveryExists).toBe(false)
    expect(outcome.destinationRecoveryPathExists).toBe(false)
    expect(outcome.sourceRecoveryExists).toBe(false)
    expect(outcome.markerExists).toBe(false)
  })

  it('fails closed when destination recovery has no target-path metadata', () => {
    const outcome = runRecoveryScript({
      markerPresent: false,
      pathMetadata: false,
      script: _internals.inspectLegacyAuthScript
    })

    expect(outcome.status).toBe(46)
    expect(outcome.destinationRecoveryExists).toBe(true)
    expect(outcome.destinationRecoveryPathExists).toBe(false)
  })

  it('deletes a promoted source only while the destination remains intact', () => {
    const changedDestination = runApplyScript({
      deleteSource: true,
      rewriteAfterHashCall: 7,
      rewriteBytes: NEWER_AUTH,
      rewriteTarget: 'target-auth'
    })
    expect(changedDestination.status).toBe(45)
    expect(changedDestination.legacyAuth).toBe(SOURCE_AUTH)
    expect(changedDestination.markerExists).toBe(false)

    const outcome = runApplyScript({ deleteSource: true })

    expect(outcome.status).toBe(0)
    expect(outcome.legacyAuth).toBeNull()
    expect(outcome.targetAuth).toBe(SOURCE_AUTH)
    expect(outcome.markerExists).toBe(true)
  })

  it('refuses to retire the source when the destination is atomically replaced after the inode pin', () => {
    // Why this needs its own case: the pinned hard link keeps the ORIGINAL inode, so its hash
    // still matches after another writer renames a different file over the destination path.
    // Only the `-ef` inode-identity assertions can see that; hash checks cannot. Without them
    // the script proceeds and retires the source, leaving the user with bytes nobody validated.
    const outcome = runApplyScript({ replaceTargetOnHashOf: '.orca-drain-destination-' })

    expect(outcome.status).not.toBe(0)
    // The source is the only thing that must survive an unproven destination.
    expect(outcome.legacyAuth).toBe(SOURCE_AUTH)
    expect(outcome.markerExists).toBe(false)
  })
})
