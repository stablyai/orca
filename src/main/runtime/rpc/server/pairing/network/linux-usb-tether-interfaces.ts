import { readlink } from 'node:fs/promises'
import { basename, join } from 'node:path'

// rndis_host: Android USB tethering; ipheth: iPhone USB tethering. Only the tethering phone can reach them.
const USB_TETHER_DRIVERS = new Set(['rndis_host', 'ipheth'])

export type UsbTetherInterfaceLookup = (names: readonly string[]) => Promise<ReadonlySet<string>>

export type LinuxUsbTetherEnvironment = {
  platform: NodeJS.Platform
  sysClassNetPath?: string
}

export async function getLinuxUsbTetherInterfaceNames(
  names: readonly string[],
  environment: LinuxUsbTetherEnvironment = { platform: process.platform }
): Promise<ReadonlySet<string>> {
  if (environment.platform !== 'linux') {
    return new Set()
  }
  const sysClassNetPath = environment.sysClassNetPath ?? '/sys/class/net'
  const tethered = await Promise.all(
    names.map(async (name) => {
      try {
        const driver = basename(await readlink(join(sysClassNetPath, name, 'device', 'driver')))
        return USB_TETHER_DRIVERS.has(driver) ? name : null
      } catch {
        return null
      }
    })
  )
  return new Set(tethered.filter((name): name is string => name !== null))
}
