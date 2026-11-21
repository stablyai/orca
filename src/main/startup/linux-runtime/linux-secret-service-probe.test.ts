import { describe, expect, it, vi } from 'vitest'
import type { ProcessResult } from '@orca/process-host/process-spec'

const { runProcessSyncMock } = vi.hoisted(() => ({ runProcessSyncMock: vi.fn() }))

vi.mock('@orca/process-host', () => ({ runProcessSync: runProcessSyncMock }))

import { probeSecretServiceCollection } from './linux-secret-service-probe'

function exited(stdout: string): ProcessResult {
  return { code: 0, signal: null, stdout, stderr: '', timedOut: false }
}

// Captured from gnome-keyring on Omarchy: the default collection reads Locked before any client opens it.
function secretService(unlockReply: string) {
  return ({ args }: { args: string[] }): ProcessResult =>
    args.includes('org.freedesktop.Secret.Service.Unlock')
      ? exited(unlockReply)
      : exited('(<true>,)\n')
}

describe('probeSecretServiceCollection', () => {
  it('opens a locked keyring that needs no password', () => {
    runProcessSyncMock.mockImplementation(
      secretService("([objectpath '/org/freedesktop/secrets/aliases/default'], objectpath '/')\n")
    )
    expect(probeSecretServiceCollection()).toBe('unlocked')
  })

  it('leaves a keyring that would prompt for its password locked', () => {
    runProcessSyncMock.mockImplementation(
      secretService("([], objectpath '/org/freedesktop/secrets/prompt/u8')\n")
    )
    expect(probeSecretServiceCollection()).toBe('locked')
  })
})
