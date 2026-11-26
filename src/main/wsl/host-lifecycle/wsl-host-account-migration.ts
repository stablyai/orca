/** An unpinned host whose server isn't its default user's (#49180): find the one account holding the paired key, and pin it once a connect verifies it. */
import { encodePairingOffer } from '../../../shared/remote-runtime/pairing/pairing'
import type { PairingOffer } from '../../../shared/remote-runtime/pairing/mobile-relay-pairing-offer'
import { resolveEnvironmentPairingOffer } from '../../../shared/remote-runtime/host-store/runtime-environment-store'
import { refreshWslHostPairing } from '../../../shared/remote-runtime/host-store/runtime-environment-wsl-host-store'
import {
  pinnableWslLinuxUser,
  type WslHostDeploymentRecord
} from '../../../shared/remote-runtime/host-store/wsl-host-deployment-store'
import { execCommand } from '../../ssh/remote-exec/remote-exec-command'
import { createWslOrcadHostTransport } from '../orcad/wsl-orcad-host-transport'
import { withWslHostLinuxUser } from '../orcad/wsl-orcad-host-user'
import { orcadPublicKeyCommand } from './wsl-host-ssh-orcad-conflict'

/** One line per account with an orcad key: `<name> <public key>`; run as root to read every home. */
export const WSL_ACCOUNT_KEYS_COMMAND = `getent passwd | while IFS=: read -r _orca_n _ _ _ _ _orca_h _; do [ -n "$_orca_h" ] && [ -d "$_orca_h/.orca" ] || continue; _orca_k=$(${orcadPublicKeyCommand('$_orca_h')}); [ -n "$_orca_k" ] && printf '%s %s\\n' "$_orca_n" "$_orca_k"; done`

/** The single account whose key is `publicKeyB64`; null when none or several hold it. */
export function accountHoldingKey(output: string, publicKeyB64: string): string | null {
  const holders = output
    .split('\n')
    .map((line) => line.trim().split(/\s+/))
    .filter(([name, key]) => key === publicKeyB64 && pinnableWslLinuxUser(name))
    .map(([name]) => name)
  return holders.length === 1 ? holders[0] : null
}

export type WslPairedAccount = { linuxUser: string; offer: PairingOffer }

/** Reads only: the account whose orcad holds the saved pairing's key, or null. */
export async function findPairedWslAccount(
  userDataPath: string,
  record: WslHostDeploymentRecord
): Promise<WslPairedAccount | null> {
  const offer = await resolveEnvironmentPairingOffer(userDataPath, record.environmentId)
  const publicKeyB64 = record.pairingPublicKeyB64 ?? offer?.publicKeyB64
  if (record.linuxUser || !offer || !publicKeyB64) {
    return null
  }
  const { distro, environmentId } = record
  const transport = createWslOrcadHostTransport({
    target: { kind: 'wsl', id: environmentId, distro, label: distro },
    user: 'root',
    commandLoops: false
  })
  try {
    const keys = await execCommand(transport, WSL_ACCOUNT_KEYS_COMMAND)
    const linuxUser = accountHoldingKey(keys, publicKeyB64)
    return linuxUser ? { linuxUser, offer } : null
  } catch (error) {
    console.warn(`[wsl-hosts] Couldn’t look for ${distro}’s paired server account:`, error)
    return null
  } finally {
    transport.dispose()
  }
}

/** Connects as `found.linuxUser` and saves the pin only once that connect verified the server. */
export async function connectAsPairedWslAccount(
  userDataPath: string,
  record: WslHostDeploymentRecord,
  found: WslPairedAccount,
  connect: () => Promise<unknown>,
  persist: (
    ...args: Parameters<typeof refreshWslHostPairing>
  ) => Promise<unknown> = refreshWslHostPairing
): Promise<void> {
  await withWslHostLinuxUser(record.distro, found.linuxUser, async () => {
    await connect()
    // The saved pairing is unchanged, so this write only adds the pin.
    await persist(userDataPath, record.environmentId, {
      pairingCode: encodePairingOffer(found.offer),
      localPort: record.localPort,
      remotePort: record.remotePort,
      linuxUser: found.linuxUser
    })
  })
}
