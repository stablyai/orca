import { randomUUID } from 'node:crypto'
import { lstat, mkdir, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { SetupAttemptRecipe } from '../../shared/agent-launch/startup/setup-attempt-recipe'
import { setupMarkerPath } from '../../shared/agent-launch/startup/setup-marker-cleanup'
import { windowsFsPath } from '../wsl/filesystem/wsl-unc-drive-fs-path'
import { assertWslUncPathRunning } from '../wsl/filesystem/wsl-unc-access-gate'

/** The host that wrote the runner may refuse its exact attempt, never replace an accepted result. */
export async function publishSetupFailureMarker(recipe: SetupAttemptRecipe, signal: AbortSignal) {
  const marker = windowsFsPath(setupMarkerPath(recipe.runnerScriptPath, recipe.nonce))
  const temporary = `${marker}.${randomUUID()}.tmp`
  let temporaryCreated = false
  try {
    signal.throwIfAborted()
    await assertWslUncPathRunning(marker)
    signal.throwIfAborted()
    await mkdir(dirname(marker)).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'EEXIST') {
        throw error
      }
    })
    signal.throwIfAborted()
    temporaryCreated = true
    await writeFile(temporary, `${recipe.nonce}:1\n`, { flag: 'wx', signal })
    signal.throwIfAborted()
    await writeFile(`${marker}.claim`, '', { flag: 'wx', signal }).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code !== 'EEXIST') {
          throw error
        }
      }
    )
    signal.throwIfAborted()
    try {
      await lstat(marker)
      return
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
        throw error
      }
    }
    signal.throwIfAborted()
    await rename(temporary, marker)
  } catch {
    // An existing result wins; inaccessible or retired runners remain fail closed.
  } finally {
    if (temporaryCreated) {
      await assertWslUncPathRunning(temporary)
        .then(() => unlink(temporary))
        .catch(() => {})
    }
  }
}
