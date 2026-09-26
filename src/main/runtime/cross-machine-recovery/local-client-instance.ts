import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { readNodeFileWithinLimit } from '../../../shared/node-bounded-file-reader'
import { durableWriteTempPath, renameDurable, writeTempFileDurable } from '../../durable-file-write'
import { withFileTransactionLock } from '../../file-transaction-lock'

export const CROSS_MACHINE_RECOVERY_CLIENT_INSTANCE_FILE =
  'cross-machine-recovery-client-instance.json'

const MAX_CLIENT_INSTANCE_FILE_BYTES = 4 * 1024

const ClientInstanceStateSchema = z
  .object({ version: z.literal(1), clientInstanceId: z.string().min(1).max(512) })
  .strict()

async function readClientInstanceId(filePath: string): Promise<string | null> {
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
  const parsed = ClientInstanceStateSchema.safeParse(JSON.parse(raw))
  if (!parsed.success) {
    throw new Error(`Corrupt cross-machine recovery client instance file: ${filePath}`)
  }
  return parsed.data.clientInstanceId
}

/**
 * The desktop's stable presentation client id, minted on first use and persisted beside the
 * profile state so an import can prefer the view this same desktop published.
 */
export function ensureLocalClientInstanceId(stateDirectory: string): Promise<string> {
  const filePath = join(stateDirectory, CROSS_MACHINE_RECOVERY_CLIENT_INSTANCE_FILE)
  return withFileTransactionLock(filePath, async () => {
    const existing = await readClientInstanceId(filePath)
    if (existing !== null) {
      return existing
    }
    const clientInstanceId = randomUUID()
    const tempPath = durableWriteTempPath(filePath)
    try {
      await writeTempFileDurable(tempPath, JSON.stringify({ version: 1, clientInstanceId }), 0o600)
      await renameDurable(tempPath, filePath)
    } finally {
      await rm(tempPath, { force: true }).catch(() => {})
    }
    return clientInstanceId
  })
}
