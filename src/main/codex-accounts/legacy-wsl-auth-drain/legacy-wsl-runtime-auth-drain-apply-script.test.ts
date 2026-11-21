import { describe, expect, it } from 'vitest'
import './legacy-wsl-runtime-auth-drain'
import {
  RETIRED_SESSION,
  SOURCE_AUTH,
  isWindows
} from './legacy-wsl-runtime-auth-drain-script-fixtures'
import { runApplyScript } from './legacy-wsl-runtime-auth-drain-script-harness'

describe.skipIf(isWindows)('legacy WSL auth drain apply script', () => {
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
})
