// Server-level memory of where authenticated direct clients connect from, kept in userData.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { writeDurableSecureJsonFile } from '../../../../shared/secure-storage/secure-file'
import { isRecord } from '../../../../shared/agent-status/child-work/agent-status-child-work-value-guards'
import type { NetworkSourceClass } from '../network-source-class'

export const NETWORK_SOURCE_POLICY_FILE = 'runtime-network-source-policy.json'

export type NetworkSourcePolicyRecord = {
  // Set only after a paired device authenticated from a public address; never cleared automatically.
  allowPublicSources?: true
  // When this server first ran the source guard; devices paired before it are grandfathered.
  guardSince?: number
}

export function readNetworkSourcePolicy(userDataPath: string): NetworkSourcePolicyRecord {
  try {
    const parsed: unknown = JSON.parse(
      readFileSync(join(userDataPath, NETWORK_SOURCE_POLICY_FILE), 'utf8')
    )
    if (!isRecord(parsed)) {
      return {}
    }
    return {
      ...(parsed.allowPublicSources === true ? { allowPublicSources: true } : {}),
      ...(typeof parsed.guardSince === 'number' && Number.isFinite(parsed.guardSince)
        ? { guardSince: parsed.guardSince }
        : {})
    }
  } catch {
    return {}
  }
}

/** The first guarded start stamps now; a failed write stamps now again next start, which only widens grandfathering. */
export function ensureNetworkSourceGuardSince(
  userDataPath: string,
  now: number
): NetworkSourcePolicyRecord & { guardSince: number } {
  const record = readNetworkSourcePolicy(userDataPath)
  if (record.guardSince !== undefined) {
    return { ...record, guardSince: record.guardSince }
  }
  const stamped = { ...record, guardSince: now }
  try {
    writeDurableSecureJsonFile(join(userDataPath, NETWORK_SOURCE_POLICY_FILE), stamped)
  } catch (error) {
    console.error('[runtime] Failed to record when the network source guard started:', error)
  }
  return stamped
}

/** Persists the first authenticated public-source sighting; later sightings cost nothing. */
export class AuthenticatedSourceRecorder {
  private publicRecorded: boolean | null = null

  constructor(private readonly userDataPath: string) {}

  note(sourceClass: NetworkSourceClass | undefined): void {
    if (sourceClass !== 'public') {
      return
    }
    this.publicRecorded ??= readNetworkSourcePolicy(this.userDataPath).allowPublicSources === true
    if (this.publicRecorded) {
      return
    }
    try {
      writeDurableSecureJsonFile(join(this.userDataPath, NETWORK_SOURCE_POLICY_FILE), {
        ...readNetworkSourcePolicy(this.userDataPath),
        allowPublicSources: true
      })
      this.publicRecorded = true
      console.log('[runtime] Recorded that a paired device connects from a public address.')
    } catch (error) {
      // Left unset so the next public sighting retries.
      console.error('[runtime] Failed to remember a public-address connection:', error)
    }
  }
}
