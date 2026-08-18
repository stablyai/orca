import { describe, expect, it, vi } from 'vitest'
import type { Store } from '../persistence'
import type { SshPtyConsumerOwnerState } from './ssh-pty-consumer-session'
import {
  claimSshPtyConsumerRecovery,
  detachSshPtyConsumerRecovery,
  rememberSshPtyConsumerRecovery
} from './ssh-pty-consumer-recovery'

describe('SSH PTY consumer recovery', () => {
  it('keeps a detached identity when a concurrent open finishes late', async () => {
    const targetId = 'remember-detach-race'
    const store = {
      getSshPtyConsumerRecovery: vi.fn().mockReturnValue(null),
      upsertSshPtyConsumerRecovery: vi.fn()
    } as unknown as Store
    const claimed = claimSshPtyConsumerRecovery(targetId, store)
    let finishOpen!: (owner: SshPtyConsumerOwnerState) => void
    const opened = new Promise<SshPtyConsumerOwnerState>((resolve) => {
      finishOpen = resolve
    })
    const remembering = opened.then((owner) =>
      rememberSshPtyConsumerRecovery({
        targetId,
        clientInstanceId: claimed.clientInstanceId,
        serverBuildId: 'relay-build',
        owner,
        store
      })
    )

    detachSshPtyConsumerRecovery(targetId, claimed.clientInstanceId)
    finishOpen({
      mode: 'negotiated',
      clientInstanceId: claimed.clientInstanceId,
      clientGeneration: 1,
      ownerGeneration: 1,
      ownerLease: 'late-owner'
    })
    await remembering

    expect(store.upsertSshPtyConsumerRecovery).not.toHaveBeenCalled()
    expect(claimSshPtyConsumerRecovery(targetId, store)).toBe(claimed)
  })
})
