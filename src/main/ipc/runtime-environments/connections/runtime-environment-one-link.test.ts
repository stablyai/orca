import { afterEach, expect, it, vi } from 'vitest'
import { createDefaultLocalOrcaProfile } from '../../../../shared/orca-profiles/orca-profiles'
import type { PairedRuntimeConnection } from '../../../../shared/remote-runtime/pairing/paired-runtime-connection'
import { runtimeRelayEndpoint } from '../../../../shared/remote-runtime/pairing/runtime-relay-endpoint'
import { initializeActiveTeamProfile } from '../../../orca-profiles/cloud-auth/active-team-capabilities'
import { remoteRuntimeOneLinkAllowed } from './runtime-environment-one-link'

afterEach(() => {
  vi.unstubAllEnvs()
  // Test files share this process: leave no signed-in account behind.
  initializeActiveTeamProfile('/orca-one-link', createDefaultLocalOrcaProfile(1))(undefined)
})

const credential = { kind: 'token' as const, deviceToken: 'token' }
const direct: PairedRuntimeConnection = {
  endpoint: 'ws://127.0.0.1:6768',
  hostPublicKeyB64: 'key',
  credential
}
const relay: PairedRuntimeConnection = {
  ...direct,
  endpoint: runtimeRelayEndpoint({
    v: 1,
    directorUrl: 'https://relay.test',
    cellUrl: 'https://cell.test',
    assignmentEpoch: 1,
    relayHostId: 'H'.repeat(16),
    e2eeFraming: 2,
    inviteToken: 'I'.repeat(43),
    inviteExpiresAt: 4_102_444_800_000
  })
}

function signInWithRelayOneLink(on: boolean): void {
  const cloud = {
    userId: 'user_r',
    cloudProfileId: 'cloud_r',
    email: 'r@example.test',
    linkedAt: 1
  }
  initializeActiveTeamProfile('/orca-one-link', { ...createDefaultLocalOrcaProfile(1), cloud })({
    accessToken: 'access',
    refreshToken: 'refresh',
    expiresAt: 2,
    identity: cloud,
    capabilities: { flags: on ? { 'relay.oneLink': true } : {}, refreshedAt: 1 }
  })
}

const allowed = () => ({
  relay: remoteRuntimeOneLinkAllowed('env-relay', relay),
  direct: remoteRuntimeOneLinkAllowed('env-direct', direct),
  wsl: remoteRuntimeOneLinkAllowed('wsl:Ubuntu', direct)
})

it('decides one link: off by default, the cloud flag for Relay hosts only, the local kill over all', () => {
  vi.stubEnv('ORCA_TEST_REMOTE_RUNTIME_ONE_LINK', '')
  vi.stubEnv('ORCA_DISABLE_REMOTE_RUNTIME_ONE_LINK', '')
  signInWithRelayOneLink(false)
  expect(allowed()).toEqual({ relay: false, direct: false, wsl: false })

  signInWithRelayOneLink(true)
  expect(allowed()).toEqual({ relay: true, direct: false, wsl: false })

  signInWithRelayOneLink(false)
  vi.stubEnv('ORCA_TEST_REMOTE_RUNTIME_ONE_LINK', '1')
  // A WSL host's open browser pane socket is what holds it awake: never one link.
  expect(allowed()).toEqual({ relay: true, direct: true, wsl: false })

  signInWithRelayOneLink(true)
  vi.stubEnv('ORCA_DISABLE_REMOTE_RUNTIME_ONE_LINK', '1')
  expect(allowed()).toEqual({ relay: false, direct: false, wsl: false })
})
