import { afterEach, describe, expect, it, vi } from 'vitest'
import { setSshProviderMissRecovery } from '../../../providers/ssh-provider-miss-recovery'
import { recoverMissingSshPtyProvider } from './missing-ssh-pty-provider-recovery'
import { registerSshPtyProvider, unregisterSshPtyProvider } from './registry'

afterEach(() => {
  setSshProviderMissRecovery(null)
  unregisterSshPtyProvider('ssh-registered')
})

describe('recoverMissingSshPtyProvider', () => {
  it('returns nothing for local spawns and when no recovery is installed', () => {
    expect(recoverMissingSshPtyProvider(null)).toBeUndefined()
    expect(recoverMissingSshPtyProvider(undefined)).toBeUndefined()
    expect(recoverMissingSshPtyProvider('ssh-missing')).toBeUndefined()
  })

  it('consults the installed recovery only for connections with no registered provider', () => {
    const recovery = vi.fn(() => Promise.resolve())
    setSshProviderMissRecovery(recovery)
    registerSshPtyProvider('ssh-registered', {} as never)

    expect(recoverMissingSshPtyProvider('ssh-registered')).toBeUndefined()
    expect(recovery).not.toHaveBeenCalled()

    const pending = recoverMissingSshPtyProvider('ssh-missing')
    expect(pending).toBeInstanceOf(Promise)
    expect(recovery).toHaveBeenCalledWith('ssh-missing')
  })

  it('lets the recovery decline a connection it does not own', () => {
    setSshProviderMissRecovery(() => undefined)
    expect(recoverMissingSshPtyProvider('ssh-missing')).toBeUndefined()
  })
})
