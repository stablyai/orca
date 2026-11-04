import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { getAppEnvironment } from '../../shared/app-environment'
import {
  PI_BACKGROUND_WORK_BRIDGE_FILE,
  getPiBackgroundWorkBridgeSource
} from './rpc-background-work-bridge-source'

/** Write the bridge once per content change; null leaves the chat without idle protection, never unlaunched. */
export async function ensurePiBackgroundWorkBridge(
  onFailed: (error: unknown) => void,
  directory?: string
): Promise<string | null> {
  const source = getPiBackgroundWorkBridgeSource()
  try {
    directory ??= join(getAppEnvironment().getPath('userData'), 'pi-native-chat')
    const path = join(directory, PI_BACKGROUND_WORK_BRIDGE_FILE)
    if ((await readFile(path, 'utf8').catch(() => null)) !== source) {
      // Pi exits when an extension fails to load, so a concurrent launch must never read a partial file.
      await mkdir(directory, { recursive: true })
      const staged = `${path}.${randomUUID()}.tmp`
      try {
        await writeFile(staged, source)
        await rename(staged, path)
      } catch (error) {
        await rm(staged, { force: true }).catch(() => {})
        throw error
      }
    }
    return path
  } catch (error) {
    onFailed(error)
    return null
  }
}
