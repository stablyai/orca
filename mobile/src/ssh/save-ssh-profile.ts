import { randomUUID } from 'expo-crypto'
import { assertConnectionRouteActive, ConnectionRouteError } from '../transport/connection-route'
import { createSshConnectionRoute } from '../transport/ssh-connection-route'
import {
  beginSshCredentialDraft,
  finishSshCredentialDraft
} from '../transport/ssh-credential-registry'
import { readSshRouteCredentials, writeSshRouteCredentials } from '../transport/ssh-route-credentials'
import type { ConnectionLogEntry, ConnectionLogSink } from '../transport/types'
import { cleanupSshCredentials } from '../transport/host-connection-route-store'
import { saveSshProfile } from './ssh-profile-store'
import { routeFromSshProfile, type SshProfile } from './ssh-profile'
import type { SshRouteCredentials } from '../transport/ssh-route-auth'

function logEntry(message: string): ConnectionLogEntry {
  return { id: randomUUID(), ts: Date.now(), level: 'info', message }
}

// Open a throwaway tunnel to verify host-key, credentials and reachability.
// The forward target is only dialed lazily, so the Orca port does not matter here.
async function testSshProfile(
  profile: SshProfile,
  jumpProfile: SshProfile | undefined,
  signal: AbortSignal,
  onLog: ConnectionLogSink
): Promise<void> {
  onLog(logEntry(`Connecting to ${profile.username}@${profile.host}:${profile.port}`))
  const provider = createSshConnectionRoute(
    routeFromSshProfile(profile, profile.targetPort ?? 22, jumpProfile)
  )
  let lease
  try {
    lease = await provider.open('ws://127.0.0.1:1', signal)
  } catch (error) {
    for (const stage of error instanceof ConnectionRouteError ? (error.stages ?? []) : []) {
      onLog(logEntry(stage.message))
    }
    throw error
  }
  assertConnectionRouteActive(signal)
  onLog(logEntry('SSH tunnel opened'))
  lease.close()
}

export async function saveSshProfileWithTest(args: {
  profile: SshProfile
  jumpProfile?: SshProfile
  credentials: SshRouteCredentials
  signal: AbortSignal
  onLog: ConnectionLogSink
}): Promise<void> {
  // Why: the write below precedes the test, so a failed edit would otherwise
  // leave — or destroy, on a partial write — the secret that still works.
  const previous = await readSshRouteCredentials(args.profile.id).catch(() => null)
  try {
    await beginSshCredentialDraft(args.profile.id)
    assertConnectionRouteActive(args.signal)
    await writeSshRouteCredentials(args.profile.id, args.credentials)
    assertConnectionRouteActive(args.signal)
    await testSshProfile(args.profile, args.jumpProfile, args.signal, args.onLog)
    assertConnectionRouteActive(args.signal)
    await saveSshProfile(args.profile)
  } catch (error) {
    if (previous) {
      await writeSshRouteCredentials(args.profile.id, previous).catch(() => {})
    }
    throw error
  } finally {
    finishSshCredentialDraft(args.profile.id)
    await cleanupSshCredentials().catch(() => {})
  }
}
