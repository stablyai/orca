import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import {
  AGENT_SESSION_RESUME_MARKER_TTL_MS,
  isExpiredAgentSessionResumeMarker,
  parseAgentSessionResumeMarker,
  type AgentSessionResumeMarker
} from '../../shared/agent-session-resume-marker'
import { readNodeFileWithinLimit } from '../../shared/node-bounded-file-reader'
import { stringifyJsonWithinByteLimit } from '../../shared/node-bounded-json-stringify'
import {
  durableWriteTempPath,
  removeStaleDurableWriteTempFiles,
  renameDurable,
  writeTempFileDurable
} from '../durable-file-write'
import { withFileTransactionLock } from '../file-transaction-lock'

export const AGENT_SESSION_RECOVERY_CAPSULE_FILE = 'agent-session-recovery.json'
const MAX_CAPSULE_BYTES = 4 * 1024 * 1024
const capsuleSchema = z.object({ version: z.literal(1), markers: z.array(z.unknown()) })

/** Advisory authorization has no backup: successful take spends it before acquisition.
 * A failed take exposes nothing; an unclaimed witness may survive until a later take or expiry. */
export class AgentSessionRecoveryCapsule {
  private readonly filePath: string

  constructor(stateDirectory: string) {
    this.filePath = join(stateDirectory, AGENT_SESSION_RECOVERY_CAPSULE_FILE)
  }

  record(markers: readonly AgentSessionResumeMarker[], now: number): Promise<void> {
    return withFileTransactionLock(
      this.filePath,
      () =>
        this.publish(markers.filter((marker) => !isExpiredAgentSessionResumeMarker(marker, now))),
      { retries: 0 }
    )
  }

  take(now: number): Promise<AgentSessionResumeMarker[]> {
    return withFileTransactionLock(
      this.filePath,
      async () => {
        let raw: string
        try {
          raw = (await readNodeFileWithinLimit(this.filePath, MAX_CAPSULE_BYTES)).buffer.toString(
            'utf8'
          )
        } catch (error) {
          if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
            return []
          }
          throw error
        }
        const capsule = capsuleSchema.parse(JSON.parse(raw))
        const markers = capsule.markers.map((value) => {
          const marker = parseAgentSessionResumeMarker(value)
          if (!marker) {
            throw new Error('agent_session_recovery_capsule_invalid')
          }
          return marker
        })
        await this.publish([])
        return markers.filter((marker) => !isExpiredAgentSessionResumeMarker(marker, now))
      },
      { retries: 0 }
    )
  }

  private async publish(markers: readonly AgentSessionResumeMarker[]): Promise<void> {
    const { serialized } = stringifyJsonWithinByteLimit({ version: 1, markers }, MAX_CAPSULE_BYTES)
    await removeStaleDurableWriteTempFiles(this.filePath, {
      minimumAgeMs: AGENT_SESSION_RESUME_MARKER_TTL_MS
    })
    const tempPath = durableWriteTempPath(this.filePath)
    try {
      await writeTempFileDurable(tempPath, serialized, 0o600)
      await renameDurable(tempPath, this.filePath)
    } finally {
      await rm(tempPath, { force: true }).catch(() => {})
    }
  }
}
