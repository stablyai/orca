import type { DeviceEntry, DeviceOrcaAccount, PairedDeviceTypist } from './device-entry'

/** Who typed a device's messages: a desktop's claim on the sending connection (several desktops can
 *  share one row), or a phone's through the installation that relays it or minted its pairing, as
 *  that installation claims now. Never a row's last claim, which may be another desktop's. Names the
 *  computer, and the phone when the message came from one. */
export function pairedDeviceTypistOf(
  deviceId: string,
  getDevice: (deviceId: string) => DeviceEntry | null,
  connectionClaim: DeviceOrcaAccount | null,
  claimOfInstance: (ownerDeviceId: string, clientInstanceId: string) => DeviceOrcaAccount | null
): PairedDeviceTypist | null {
  const device = getDevice(deviceId)
  if (!device) {
    return null
  }
  if (device.scope !== 'mobile') {
    return connectionClaim ? withComputer(connectionClaim, device) : null
  }
  const ownerId = device.parentDeviceId ?? device.createdByDeviceId
  let owner = ownerId ? getDevice(ownerId) : null
  let origin = device.originClientInstanceId
  // A phone's own pairing, minted through its relayed row, speaks for that row's desktop.
  const mintedThroughRelay = owner?.scope === 'mobile' && owner.parentDeviceId !== undefined
  if (mintedThroughRelay && owner?.parentDeviceId) {
    origin ??= owner.originClientInstanceId
    owner = getDevice(owner.parentDeviceId)
  }
  const claim = owner && origin ? claimOfInstance(owner.deviceId, origin) : null
  if (!owner || !claim) {
    return null
  }
  const account = withComputer(claim, owner)
  const phone = phoneNameOf(device, account.computer, mintedThroughRelay)
  return { ...account, ...(phone ? { phone } : {}) }
}

// Pairing names desktops "Runtime <date>" or "CLI <date>", which say nothing about the computer.
const DATED_PAIRING_NAME = /^(Runtime|CLI) \d/

function withComputer(account: DeviceOrcaAccount, device: DeviceEntry): DeviceOrcaAccount {
  const computer =
    account.computer || (DATED_PAIRING_NAME.test(device.name) ? undefined : device.name)
  return { id: account.id, name: account.name, ...(computer ? { computer } : {}) }
}

// A relayed phone's row reads "<phone> via <its computer>", named by the relay from its own machine
// name, which may differ from the claim's computer (an older relay declares none); keep the phone.
function phoneNameOf(
  device: DeviceEntry,
  computer: string | undefined,
  mintedThroughRelay: boolean
): string | undefined {
  const exact = computer ? ` via ${computer}` : null
  const relayed = device.parentDeviceId !== undefined || mintedThroughRelay
  const name =
    relayed && exact && device.name.endsWith(exact)
      ? device.name.slice(0, -exact.length)
      : relayed && device.name.lastIndexOf(' via ') > 0
        ? device.name.slice(0, device.name.lastIndexOf(' via '))
        : device.name
  return name.trim() || undefined
}

export function sameOrcaAccount(
  left: DeviceOrcaAccount | null | undefined,
  right: DeviceOrcaAccount | null | undefined
): boolean {
  return left?.id === right?.id && left?.name === right?.name && left?.computer === right?.computer
}
