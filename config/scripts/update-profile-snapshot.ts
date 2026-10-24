import { createUpdateProfileSnapshot } from '../../src/main/update-profile-snapshot'
import { restoreUpdateProfileSnapshot } from '../../src/main/update-profile-restore'

async function main(): Promise<void> {
  const [action, source, destination] = process.argv.slice(2)
  if (!source || !destination || !['backup', 'restore'].includes(action)) {
    throw new Error(
      'Usage: update-profile-snapshot.ts backup <profile> <backup-root> | restore <backup> <new-profile>'
    )
  }
  if (action === 'backup') {
    console.log(await createUpdateProfileSnapshot(source, 'manual-pre-update', destination))
  } else {
    await restoreUpdateProfileSnapshot(source, destination)
    console.log('Restored and verified into the new profile. The original profile was not changed.')
  }
}
void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error))
  if (error instanceof Error && error.cause instanceof Error) {
    console.error(error.cause.message)
  }
  process.exitCode = 1
})
