import { describe, expect, it } from 'vitest'
import { _internals } from './legacy-wsl-runtime-auth-drain'
import {
  NEWER_AUTH,
  RETIRED_SESSION,
  SOURCE_AUTH,
  TARGET_AUTH,
  isWindows
} from './legacy-wsl-runtime-auth-drain-script-fixtures'
import { runApplyScript } from './legacy-wsl-runtime-auth-drain-script-harness'
import {
  runAbsentLegacyHomeScript,
  runRecoveryScript
} from './legacy-wsl-runtime-auth-drain-recovery-script-harness'

describe.skipIf(isWindows)('legacy WSL auth drain apply script', () => {
  it('does not finalize while an authless legacy home still holds sessions', () => {
    const outcome = runAbsentLegacyHomeScript({
      createLegacyHome: true,
      script: _internals.finalizeAbsentAuthScript
    })

    expect(outcome.status).toBe(47)
    expect(outcome.markerExists).toBe(false)
  })

  it('refuses torn bytes and leaves the account home intact', () => {
    // Hash 1 checks the source before a rotation can change the bytes copied for promotion.
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

  it('does not overwrite auth changed after the destination hash check', () => {
    const outcome = runApplyScript({
      rewriteBytes: NEWER_AUTH,
      rewriteAfterHashCall: 4,
      rewriteTarget: 'target-auth'
    })
    expect(outcome.status).toBe(39)
    expect(outcome.targetAuth).toBe(NEWER_AUTH)
  })

  it('recovers the source and destination mode after abrupt interruption', () => {
    const outcome = runApplyScript({ deleteSource: true, killAfterSourceRemoval: true })

    expect(outcome.signal).toBe('SIGKILL')
    expect(outcome.legacyAuth).toBe(SOURCE_AUTH)
    expect(outcome.targetAuth).toBe(SOURCE_AUTH)
    expect(outcome.targetMode).toBe(0o600)
    expect(outcome.markerExists).toBe(false)
  })

  it('retains verified destination recovery when the target inode changed after a crash', () => {
    const outcome = runApplyScript({
      deleteSource: true,
      killAfterSourceRemoval: true,
      replaceTargetBeforeRecovery: true
    })

    expect(outcome.signal).toBe('SIGKILL')
    expect(outcome.legacyAuth).toBe(SOURCE_AUTH)
    expect(outcome.targetAuth).toBe(NEWER_AUTH)
    expect(outcome.destinationRecoveryAuth).toBe(SOURCE_AUTH)
    expect(outcome.destinationRecoveryPathExists).toBe(true)
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

    expect(outcome.signal).toBe('SIGKILL')
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

    expect(outcome.signal).toBe('SIGKILL')
    expect(outcome.legacyAuth).toBe(SOURCE_AUTH)
    expect(outcome.targetSession).toBe(RETIRED_SESSION)
    expect(outcome.sessionCommitMarkerExists).toBe(false)
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

  it('refuses to retire the source when the destination is atomically replaced after the inode pin', () => {
    // A pinned inode's matching hash cannot detect path replacement; -ef must guard source retirement.
    const outcome = runApplyScript({ replaceTargetOnHashOf: '.orca-drain-destination-' })

    expect(outcome.status).not.toBe(0)
    expect(outcome.legacyAuth).toBe(SOURCE_AUTH)
    expect(outcome.markerExists).toBe(false)
  })
})
