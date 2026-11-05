import { randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { getAppEnvironment } from '../../shared/app-environment'
import { inspectProcessLiveness } from '../daemon/daemon-process-inspection'
import {
  PI_BACKGROUND_WORK_BRIDGE_FILE,
  getPiBackgroundWorkBridgeSource
} from './rpc-background-work-bridge-source'

export type PiBackgroundWorkLaunch = {
  extension: string
  /** This child's private request folder, named for the Orca process that owns it; the child creates it. */
  directory: string
}

/** Write the bridge once per content change; null leaves the chat without idle protection, never unlaunched. */
export async function ensurePiBackgroundWorkBridge(
  onFailed: (error: unknown) => void,
  directory?: string
): Promise<PiBackgroundWorkLaunch | null> {
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
    const probes = join(directory, 'probes')
    await reclaimAbandonedProbeFolders(probes)
    return { extension: path, directory: join(probes, `${process.pid}-${randomUUID()}`) }
  } catch (error) {
    onFailed(error)
    return null
  }
}

/** A folder outlives its child only when Orca crashed; its owner's process proves it abandoned. */
async function reclaimAbandonedProbeFolders(probes: string): Promise<void> {
  const names = await readdir(probes).catch(() => [])
  await Promise.all(
    names.map(async (name) => {
      const owner = Number(name.split('-')[0])
      if (
        !Number.isInteger(owner) ||
        owner === process.pid ||
        inspectProcessLiveness(owner).status !== 'exited'
      ) {
        return
      }
      await rm(join(probes, name), { recursive: true, force: true }).catch(() => {})
    })
  )
}
