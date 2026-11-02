/** Which recorded `wsl.exe` holders an Orca launch keeps, and releasing the rest (E11). */
import { existsSync } from 'node:fs'
import { readWslHostDeployments } from '../../shared/wsl-host-deployment-store'
import { sameWslDistro } from './wsl-host-add-admission'
import {
  createWslDistroHolder,
  type WslDistroHolder,
  type WslDistroHolderAdoption
} from './wsl-distro-holder'
import {
  listWslDistroHolderRecordDistros,
  wslDistroHolderDirectory
} from './wsl-distro-holder-record'

/**
 * Which holders to keep: none when hosts are off (`keepHostHolders` false); else a host's, re-read per holder so an Add
 * that lands meanwhile keeps its own. Unreadable host records keep every holder (unverifiable),
 * and a host whose Remove is pending already released its holder, so nothing re-adopts it.
 */
export function wslHolderKeepPolicy(args: {
  userDataPath: string
  keepHostHolders: boolean
  isAdding?: (distro: string) => boolean
}): (distro: string) => boolean {
  return (distro) => {
    if (!args.keepHostHolders) {
      return false
    }
    if (args.isAdding?.(distro)) {
      return true
    }
    try {
      const { deployments, unreadableEnvironmentIds } = readWslHostDeployments(args.userDataPath)
      return (
        unreadableEnvironmentIds.size > 0 ||
        deployments.some((record) => sameWslDistro(record.distro, distro) && !record.pendingStop)
      )
    } catch (error) {
      console.warn('[wsl-hosts] Could not read WSL host records; keeping the holder:', error)
      return true
    }
  }
}

/**
 * Releases the recorded holders `isWanted` refuses. With no holder ever recorded (every user who
 * never ran a WSL host) it only checks that one folder exists: no process table, no `wsl.exe`.
 */
export async function releaseUnwantedWslHolders(args: {
  userDataPath: string
  isWanted: (distro: string) => boolean
  holder?: () => WslDistroHolder
}): Promise<WslDistroHolderAdoption[]> {
  if (!existsSync(wslDistroHolderDirectory(args.userDataPath))) {
    return []
  }
  const unwanted = (await listWslDistroHolderRecordDistros(args.userDataPath)).filter(
    (distro) => !args.isWanted(distro)
  )
  if (unwanted.length === 0) {
    return []
  }
  const holder = args.holder?.() ?? createWslDistroHolder({ userDataPath: args.userDataPath })
  return Promise.all(
    unwanted.map(async (distro) => ({ distro, state: await holder.release(distro) }))
  )
}
