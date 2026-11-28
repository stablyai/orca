import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { selectAutoAdvertisedPairingAddress } from '../../../../../../shared/remote-runtime/pairing/pairing-address-auto-selection'
import { getLinuxUsbTetherInterfaceNames } from './linux-usb-tether-interfaces'

let sysClassNetPath: string | undefined

function addInterface(root: string, name: string, driver: string | null): void {
  const deviceDir = join(root, name, 'device')
  mkdirSync(deviceDir, { recursive: true })
  if (driver) {
    symlinkSync(join('..', '..', 'bus', 'usb', 'drivers', driver), join(deviceDir, 'driver'))
  }
}

afterEach(() => {
  if (sysClassNetPath) {
    rmSync(sysClassNetPath, { recursive: true, force: true })
    sysClassNetPath = undefined
  }
})

describe('Linux USB tether pairing interfaces', () => {
  it.skipIf(process.platform === 'win32')(
    'never auto-advertises a phone USB tether over the LAN adapter',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'orca-sys-class-net-'))
      sysClassNetPath = root
      addInterface(root, 'enp0s20u5', 'rndis_host')
      addInterface(root, 'enp5s0', 'r8169')
      addInterface(root, 'wg0', null)

      const tethers = await getLinuxUsbTetherInterfaceNames(['enp0s20u5', 'enp5s0', 'wg0'], {
        platform: 'linux',
        sysClassNetPath: root
      })

      expect([...tethers]).toEqual(['enp0s20u5'])
      expect(
        selectAutoAdvertisedPairingAddress([
          { name: 'enp0s20u5', address: '192.168.166.226', isUsbTether: tethers.has('enp0s20u5') },
          { name: 'enp5s0', address: '192.168.10.17', isUsbTether: tethers.has('enp5s0') }
        ])
      ).toBe('192.168.10.17')
    }
  )
})
