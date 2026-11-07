// Server-level memory of where authenticated direct clients connect from, kept in userData.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { writeDurableSecureJsonFile } from '../../../../shared/secure-file'
import { isRecord } from '../../../../shared/agent-status/child-work/agent-status-child-work-value-guards'
import type { NetworkSourceClass } from '../network-source-class'

export const NETWORK_SOURCE_POLICY_FILE = 'runtime-network-source-policy.json'

export type NetworkSourcePolicyRecord = {
  // Set only after a paired device authenticated from a public address; never cleared automatically.
  allowPublicSources?: true
}

export function readNetworkSourcePolicy(userDataPath: string): NetworkSourcePolicyRecord {
  try {
    const parsed: unknown = JSON.parse(
      readFileSync(join(userDataPath, NETWORK_SOURCE_POLICY_FILE), 'utf8')
    )
    return isRecord(parsed) && parsed.allowPublicSources === true
      ? { allowPublicSources: true }
      : {}
  } catch {
    return {}
  }
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
