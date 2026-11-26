import { afterEach, describe, expect, it } from 'vitest'
import type { PairingOffer } from '../../../shared/remote-runtime/pairing/mobile-relay-pairing-offer'
import type { WslHostDeploymentRecord } from '../../../shared/remote-runtime/host-store/wsl-host-deployment-store'
import { WslHostAccountChangedError } from '../orcad/wsl-orcad-account-facts'
import { pinnedWslHostLinuxUser, pinWslHostLinuxUsers } from '../orcad/wsl-orcad-host-user'
import { recoverWslOrcad } from '../orcad/wsl-orcad-liveness-recovery'
import { WslOrcadReconnectBackoff } from '../orcad/wsl-orcad-reconnect-backoff'
import type { WslOrcadConnectionStatus } from '../orcad/wsl-orcad-connection-status'
import { UNVERIFIABLE_ORCAD_TERMINAL_CENSUS } from '../../../shared/remote-runtime/orcad-lifecycle/orcad-terminal-census'
import { retryableConnectFailure } from './wsl-host-connect-failure'
import { OrcadManagedIdentityError } from '../../managed-server/lifecycle/orcad-managed-tunnel-identity'
import {
  accountHoldingKey,
  connectAsPairedWslAccount,
  WSL_ACCOUNT_KEYS_COMMAND
} from './wsl-host-account-migration'
import { execFileSync } from 'node:child_process'

const changed = new WslHostAccountChangedError('Ubuntu-24.04', { uid: '1001', name: 'qauser' })
const offer: PairingOffer = {
  v: 2,
  endpoint: 'ws://127.0.0.1:41000',
  publicKeyB64: Buffer.alloc(32, 1).toString('base64'),
  deviceToken: 'device-token',
  pairedDeviceId: 'paired-client'
}
const record: WslHostDeploymentRecord = {
  kind: 'wsl',
  distro: 'Ubuntu-24.04',
  localPort: 41000,
  remotePort: 6800,
  environmentId: 'wsl:ubuntu-24.04',
  createdAt: 1
}

// #49180: an unpinned host whose default user changed waits on the user's Connect.
describe('a WSL host whose default account no longer serves its pairing', () => {
  it('is final for runtime calls and liveness, which shows it instead of reconnecting', async () => {
    expect(retryableConnectFailure('Ubuntu-24.04', changed)).toBe(changed)
    const published: WslOrcadConnectionStatus[] = []
    let attempts = 0
    await recoverWslOrcad(
      {
        distro: 'Ubuntu-24.04',
        backoff: new WslOrcadReconnectBackoff(() => 0),
        now: () => 0,
        current: () => true,
        wait: async () => {},
        publish: (status) => published.push(status),
        ensure: async () => {
          attempts += 1
          throw changed
        },
        collectCensus: async () => UNVERIFIABLE_ORCAD_TERMINAL_CENSUS,
        arm: async () => {},
        readRunning: async () => ({ status: 'confirmed', distros: ['Ubuntu-24.04'] })
      },
      'orcad-exited'
    )
    expect(attempts).toBe(1)
    expect(published.at(-1)).toMatchObject({ state: 'failed', reason: changed.message })
  })

  it('keeps backing off on a guessed foreign answer but stops on a sealed one', async () => {
    const run = async (error: Error): Promise<number> => {
      let attempts = 0
      await recoverWslOrcad(
        {
          distro: 'Ubuntu-24.04',
          backoff: new WslOrcadReconnectBackoff(() => 0),
          now: () => 0,
          current: () => true,
          wait: async () => {},
          publish: () => {},
          ensure: async () => {
            attempts += 1
            throw error
          },
          collectCensus: async () => UNVERIFIABLE_ORCAD_TERMINAL_CENSUS,
          arm: async () => {},
          readRunning: async () => ({ status: 'confirmed', distros: ['Ubuntu-24.04'] })
        },
        'orcad-exited'
      )
      return attempts
    }
    // A bridge port briefly answered by something else during a restart: not proof.
    expect(
      await run(OrcadManagedIdentityError.foreignPort(6800, 'status.get failed'))
    ).toBeGreaterThan(1)
    expect(await run(OrcadManagedIdentityError.foreignPort(6800, 'closed 4003', true))).toBe(1)
  })
})

describe('pinning the account behind an unpinned host', () => {
  afterEach(() => pinWslHostLinuxUsers([]))

  // The root probe's quoting (timeout wrapper around the script) must stay valid sh.
  it.skipIf(process.platform === 'win32')('keeps the root probe valid sh', () => {
    expect(() => execFileSync('sh', ['-n', '-c', WSL_ACCOUNT_KEYS_COMMAND])).not.toThrow()
  })

  it('pins only the one account whose orcad holds the paired key', () => {
    const keys = 'root AAAA\nqauser BBBB\n'
    expect(accountHoldingKey(keys, 'AAAA')).toBe('root')
    expect(accountHoldingKey(keys, 'CCCC')).toBeNull()
    expect(accountHoldingKey(`${keys}bob AAAA\n`, 'AAAA')).toBeNull()
    expect(accountHoldingKey('-x AAAA\n', 'AAAA')).toBeNull()
  })

  it('saves the pin only after the connect as that account verified it', async () => {
    const saved: unknown[] = []
    const persist = async (...args: unknown[]): Promise<void> => void saved.push(args)
    const failing = connectAsPairedWslAccount(
      '/user-data',
      record,
      { linuxUser: 'root', offer },
      async () => {
        expect(pinnedWslHostLinuxUser(record.distro)).toBe('root')
        throw new Error('identity mismatch')
      },
      persist
    )
    await expect(failing).rejects.toThrow('identity mismatch')
    expect(saved).toEqual([])
    expect(pinnedWslHostLinuxUser(record.distro)).toBeUndefined()

    await connectAsPairedWslAccount(
      '/user-data',
      record,
      { linuxUser: 'root', offer },
      async () => {},
      persist
    )
    expect(saved).toMatchObject([['/user-data', record.environmentId, { linuxUser: 'root' }]])
    // Kept in memory past the trial, so the holder and liveness stay on root until the next read.
    expect(pinnedWslHostLinuxUser(record.distro)).toBe('root')
  })

  it('runs one trial per host and ends a hung one, dropping its account', async () => {
    let connects = 0
    let seen: AbortSignal | undefined
    const hung = (signal: AbortSignal): Promise<never> => {
      connects += 1
      seen = signal
      return new Promise<never>(() => {})
    }
    const persist = async (): Promise<void> => {}
    const first = connectAsPairedWslAccount(
      '/u',
      record,
      { linuxUser: 'root', offer },
      hung,
      persist,
      20
    )
    const second = connectAsPairedWslAccount(
      '/u',
      record,
      { linuxUser: 'root', offer },
      hung,
      persist,
      20
    )
    await expect(first).rejects.toThrow(/too long/)
    await expect(second).rejects.toThrow(/too long/)
    expect(connects).toBe(1)
    // Aborted, so none of the connect's later steps run once the override is gone.
    expect(seen?.aborted).toBe(true)
    expect(pinnedWslHostLinuxUser(record.distro)).toBeUndefined()
  })
})
