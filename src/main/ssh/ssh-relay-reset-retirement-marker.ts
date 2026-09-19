import { parseSshRelayResetIntent, type SshRelayResetIntent } from './ssh-relay-reset-intent'

export type SshRelayResetRetirementMarker = Readonly<{
  version: 1
  kind: 'archived'
  intent: SshRelayResetIntent
  archiveSha256: string
}>

export function parseSshRelayResetRetirementMarker(
  value: unknown,
  targetId: string
): SshRelayResetRetirementMarker {
  const raw = value as SshRelayResetRetirementMarker | null
  if (
    !raw ||
    raw.version !== 1 ||
    raw.kind !== 'archived' ||
    typeof raw.archiveSha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(raw.archiveSha256)
  ) {
    throw new Error('ssh_relay_reset_retirement_marker_invalid')
  }
  const intent = parseSshRelayResetIntent(raw.intent)
  if (intent.targetId !== targetId) {
    throw new Error('ssh_relay_reset_retirement_marker_target_mismatch')
  }
  return Object.freeze({ version: 1, kind: 'archived', intent, archiveSha256: raw.archiveSha256 })
}
