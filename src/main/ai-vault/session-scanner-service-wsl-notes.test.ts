import { afterEach, describe, expect, it } from 'vitest'
import {
  _resetWslBackgroundDistroGateForTests,
  noteWslDistroMayHaveStopped,
  noteWslDistroWoken
} from '../wsl-background-distro-gate'
import { AiVaultScannerServiceClient } from './session-scanner-service-client'
import {
  AiVaultServiceTestChild,
  readyAiVaultServiceChild
} from './session-scanner-service-test-child'

afterEach(() => {
  _resetWslBackgroundDistroGateForTests()
})

// verify-18 (a): a `wsl --terminate` main saw must reach the scanner before its running lease would.
describe('the session scanner hears main WSL stop and wake notes', () => {
  it('forwards notes to a live child and stops after dispose', async () => {
    const child = new AiVaultServiceTestChild()
    const client = new AiVaultScannerServiceClient({
      processFactory: () => child.asChildProcess(),
      init: () => ({ sessionParseCache: null, sessionSearch: null })
    })
    void client.request({ type: 'request', operation: 'titles', requests: [] }).catch(() => {})
    readyAiVaultServiceChild(child)
    await Promise.resolve()

    noteWslDistroMayHaveStopped('Ubuntu')
    noteWslDistroWoken('Debian')
    expect(child.sent).toEqual(
      expect.arrayContaining([
        { type: 'wslDistroNote', kind: 'stopped', distro: 'Ubuntu' },
        { type: 'wslDistroNote', kind: 'woken', distro: 'Debian' }
      ])
    )

    client.dispose()
    const sentBefore = child.sent.length
    noteWslDistroMayHaveStopped('Ubuntu')
    expect(child.sent).toHaveLength(sentBefore)
  })
})
