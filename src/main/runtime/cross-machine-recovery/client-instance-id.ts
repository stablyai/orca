import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { z } from 'zod'
import { readNodeFileWithinLimit } from '../../../shared/node-bounded-file-reader'
import { durableWriteTempPath, renameDurable, writeTempFileDurable } from '../../durable-file-write'
import { withFileTransactionLock } from '../../file-transaction-lock'

export const CROSS_MACHINE_RECOVERY_CLIENT_INSTANCE_FILE =
  'cross-machine-recovery-client-instance.json'

const MAX_CLIENT_INSTANCE_FILE_BYTES = 4096

const StoredClientInstance = z.object({ clientInstanceId: z.string().uuid() }).strict()

async function readStoredClientInstanceId(filePath: string): Promise<string | null> {
  let raw: string
  try {
    raw = (await readNodeFileWithinLimit(filePath, MAX_CLIENT_INSTANCE_FILE_BYTES)).buffer.toString(
      'utf8'
    )
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return null
    }
    throw error
  }
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    return null
  }
  const parsed = StoredClientInstance.safeParse(json)
  return parsed.success ? parsed.data.clientInstanceId : null
}

/** Reads this desktop's stable recovery client id, minting and persisting it on first use. */
export function readOrMintCrossMachineRecoveryClientInstanceId(
  stateDirectory: string
): Promise<string> {
  const filePath = join(stateDirectory, CROSS_MACHINE_RECOVERY_CLIENT_INSTANCE_FILE)
  return withFileTransactionLock(filePath, async () => {
    const existing = await readStoredClientInstanceId(filePath)
    if (existing) {
      return existing
    }
    const clientInstanceId = randomUUID()
    const tempPath = durableWriteTempPath(filePath)
    await writeTempFileDurable(tempPath, JSON.stringify({ clientInstanceId }), 0o600)
    await renameDurable(tempPath, filePath)
    return clientInstanceId
  })
}
