import { describe, expect, it } from 'vitest'
import { gitOptionsForWorktree } from './git-runtime-options'

describe('Git runtime remote-operation options', () => {
  it('propagates one absolute deadline through preparatory local and WSL Git', () => {
    const remoteOperationDeadline = {
      startedAtMs: 100,
      timeoutMs: 5_000,
      expiresAtMs: 5_100
    }

    expect(
      gitOptionsForWorktree('/repo', {
        remoteOperationDeadline,
        wslDistro: 'Ubuntu'
      })
    ).toMatchObject({
      cwd: '/repo',
      killProcessTree: true,
      processTreeCleanupDeadlineMs: remoteOperationDeadline.expiresAtMs,
      wslDistro: 'Ubuntu'
    })
  })
})
