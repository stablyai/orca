import { createHash } from 'node:crypto'
import { serializeOrcadMigrationValue } from '../../../shared/orcad-migration-manifest'
import { parsePtyOwnershipInitialModelSnapshot } from './pty-ownership-transfer-initial-model-snapshot'

/** Hash the validated model, dimensions and restore state, not its transport key ordering. */
export function digestPtyOwnershipInitialModelSnapshot(
  ...args: Parameters<typeof parsePtyOwnershipInitialModelSnapshot>
): string {
  const snapshot = parsePtyOwnershipInitialModelSnapshot(...args)
  return createHash('sha256').update(serializeOrcadMigrationValue(snapshot)).digest('hex')
}
