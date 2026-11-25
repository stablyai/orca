import { randomUUID } from 'node:crypto'
import { readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { getAppEnvironment } from '../../../../shared/app-lifecycle/app-environment'
import { writePiExtensionFile } from '../launch/pi-extension-file'
import { inspectProcessLiveness } from '../../../daemon/endpoint/identity/daemon-process-inspection'
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
    const path = await writePiExtensionFile(directory, PI_BACKGROUND_WORK_BRIDGE_FILE, source)
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
