import { describe, expect, it } from 'vitest'
import {
  getPreferredPairedRuntimeConnection,
  type KnownRuntimeEnvironment
} from '../../shared/runtime-environments'
import { derivePairedRuntimeBrowserAuthorityIdentities } from './paired-runtime-browser-authority-identity'
import {
  pairedRuntimeHostEnvironment,
  preW1AuthorityConnectionIdentity,
  WSL_DISTRO_ID_B
} from './paired-runtime-browser-host-environment-fixture'

const orcaProfileId = 'orca-profile-a'

function identitiesFor(environment: KnownRuntimeEnvironment, authorityRuntimeId = 'runtime-a') {
  return derivePairedRuntimeBrowserAuthorityIdentities({
    orcaProfileId,
    environment,
    connection: getPreferredPairedRuntimeConnection(environment),
    authorityRuntimeId
  })
}

function preW1Identity(environment: KnownRuntimeEnvironment): string {
  return preW1AuthorityConnectionIdentity(
    orcaProfileId,
    environment,
    getPreferredPairedRuntimeConnection(environment)
  )
}

describe('paired runtime browser authority identity', () => {
  // Why: these hosts only re-pair when the user does, so their partition must not move at all.
  it.each(['manual', 'plain-ssh'] as const)(
    'keeps a %s host on exactly the pre-W1 identity',
    (kind) => {
      const environment = pairedRuntimeHostEnvironment({ kind, pairedDeviceId: 'device-a' })

      const identities = identitiesFor(environment)

      expect(identities.authorityConnectionIdentity).toBe(preW1Identity(environment))
      expect(identities.authorityConnectionIdentity).toBe(
        kind === 'manual'
          ? 'paired-runtime:3f64da5001beab84d740e02278c2deb50dada2355569a37a5014cd041119c1c9'
          : 'paired-runtime:e67dcb68fcac0c461b7ac304ba6f6cf093c163d78a7584b210c5f90efa8360f6'
      )
    }
  )

  it.each(['managed-ssh', 'wsl'] as const)(
    'keeps a %s host on one identity across an orcad re-pair',
    (kind) => {
      const before = identitiesFor(
        pairedRuntimeHostEnvironment({ kind, pairingRevision: 1_000, pairedDeviceId: 'device-a' }),
        'runtime-a'
      )
      const rePaired = pairedRuntimeHostEnvironment({
        kind,
        pairingRevision: 2_000,
        pairedDeviceId: 'device-b'
      })
      const after = identitiesFor(rePaired, 'runtime-b')

      expect(after.authorityConnectionIdentity).toBe(before.authorityConnectionIdentity)
      // The pre-W1 identity at the current pairing stays adoptable, so an upgrade keeps its jar.
      expect(after.adoptableAuthorityConnectionIdentities).toEqual([preW1Identity(rePaired)])
    }
  )

  it('fails closed to the pre-W1 identity for a WSL host without a registration GUID', () => {
    const environment = pairedRuntimeHostEnvironment({
      kind: 'wsl',
      distroId: null,
      pairedDeviceId: 'device-a'
    })

    const identities = identitiesFor(environment)

    expect(identities.authorityConnectionIdentity).toBe(preW1Identity(environment))
    expect(identities.adoptableAuthorityConnectionIdentities).toEqual([])
  })

  // Why: each names a different machine or registration, so sharing would leak one's cookies to another.
  it('separates environments, server keys, host kinds, and re-imported distros', () => {
    const identities = [
      identitiesFor(pairedRuntimeHostEnvironment({ kind: 'managed-ssh' })),
      identitiesFor(pairedRuntimeHostEnvironment({ kind: 'managed-ssh', id: 'environment-b' })),
      identitiesFor(
        pairedRuntimeHostEnvironment({ kind: 'managed-ssh', publicKeyB64: 'host-key-b' })
      ),
      identitiesFor(pairedRuntimeHostEnvironment({ kind: 'wsl', id: 'environment-managed-ssh' })),
      identitiesFor(pairedRuntimeHostEnvironment({ kind: 'wsl' })),
      identitiesFor(pairedRuntimeHostEnvironment({ kind: 'wsl', distroId: WSL_DISTRO_ID_B })),
      identitiesFor(pairedRuntimeHostEnvironment({ kind: 'wsl', publicKeyB64: 'host-key-b' }))
    ].map((entry) => entry.authorityConnectionIdentity)

    expect(new Set(identities).size).toBe(identities.length)
  })
})
