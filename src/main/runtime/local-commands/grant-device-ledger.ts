import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Written by /opt/orca/bin/orca-sandbox-grant: one device id per line for every offer minted for a
 *  teammate's (or any granted) device. The workspace owner's own desktop pairs from the VM's first
 *  offer and is never listed. Best effort only: anything with a shell as the VM user can mint an
 *  unlisted offer or edit this file. It keeps an ordinary teammate's Orca from seeing or answering
 *  requests; the person's computer is protected by its own desktop checks, not by this. */
export function grantDeviceLedgerPath(home = homedir()): string {
  return join(home, '.orca-sandbox', 'grant-devices')
}

/** True when the device came from a grant. An unreadable ledger (other than missing) counts as yes. */
export function isGrantedDevice(
  originDeviceId: string,
  read: () => string = () => readFileSync(grantDeviceLedgerPath(), 'utf8')
): boolean {
  let text: string
  try {
    text = read()
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code !== 'ENOENT'
  }
  return text.split('\n').some((line) => line.trim() === originDeviceId)
}
