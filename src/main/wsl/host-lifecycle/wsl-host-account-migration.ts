/** An unpinned host whose default user changed (#49180): pin the one account holding the paired key; the connect still verifies it. */
import { encodePairingOffer } from '../../../shared/remote-runtime/pairing/pairing'
import { resolveEnvironmentPairingOffer } from '../../../shared/remote-runtime/host-store/runtime-environment-store'
import { refreshWslHostPairing } from '../../../shared/remote-runtime/host-store/runtime-environment-wsl-host-store'
import {
  pinnableWslLinuxUser,
  type WslHostDeploymentRecord
} from '../../../shared/remote-runtime/host-store/wsl-host-deployment-store'
import { execCommand } from '../../ssh/remote-exec/remote-exec-command'
import { createWslOrcadHostTransport } from '../orcad/wsl-orcad-host-transport'
import { pinWslHostLinuxUser } from '../orcad/wsl-orcad-host-user'
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

/** Pins and returns the account serving the saved pairing; null leaves the record unpinned. */
export async function pinUnpinnedWslHostAccount(
  userDataPath: string,
  record: WslHostDeploymentRecord
): Promise<string | null> {
  if (record.linuxUser) {
    return null
  }
  const offer = await resolveEnvironmentPairingOffer(userDataPath, record.environmentId)
  const publicKeyB64 = record.pairingPublicKeyB64 ?? offer?.publicKeyB64
  if (!offer || !publicKeyB64) {
    return null
  }
  const { distro, environmentId } = record
  const transport = createWslOrcadHostTransport({
    target: { kind: 'wsl', id: environmentId, distro, label: distro },
    user: 'root',
    commandLoops: false
  })
  let linuxUser: string | null
  try {
    linuxUser = accountHoldingKey(
      await execCommand(transport, WSL_ACCOUNT_KEYS_COMMAND),
      publicKeyB64
    )
  } catch (error) {
    console.warn(`[wsl-hosts] Couldn’t look for ${distro}’s paired server account:`, error)
    return null
  } finally {
    transport.dispose()
  }
  if (!linuxUser) {
    return null
  }
  // The saved pairing is unchanged, so this write only adds the pin.
  await refreshWslHostPairing(userDataPath, environmentId, {
    pairingCode: encodePairingOffer(offer),
    localPort: record.localPort,
    remotePort: record.remotePort,
    linuxUser
  })
  pinWslHostLinuxUser(distro, linuxUser)
  return linuxUser
}
