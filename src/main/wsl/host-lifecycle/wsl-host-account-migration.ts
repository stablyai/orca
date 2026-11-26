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
import { pinWslHostLinuxUser, withWslHostLinuxUser } from '../orcad/wsl-orcad-host-user'
import { WslHostAccountChangedError } from '../orcad/wsl-orcad-account-facts'
import { ORCAD_PUBLIC_KEY_SED } from './wsl-host-ssh-orcad-conflict'
import { E2EE_KEYPAIR_FILENAME } from '../../../shared/remote-runtime/host-store/runtime-e2ee-keypair-file'
import { quotePosixShell } from '../../../shared/shell/launch/shell-argument-quoting'

/** The scan over `passwd` lines (`getent passwd`; a test seam swaps the source). */
function accountKeysScript(passwd: string): string {
  return `${passwd} | while IFS=: read -r _orca_n _ _ _ _ _orca_h _; do _orca_f="$_orca_h/.orca/${E2EE_KEYPAIR_FILENAME}"; [ -n "$_orca_h" ] && [ ! -L "$_orca_h/.orca" ] && [ -f "$_orca_f" ] && [ ! -L "$_orca_f" ] || continue; _orca_k=$(head -c 4096 "$_orca_f" | ${ORCAD_PUBLIC_KEY_SED} | head -n 1); [ -n "$_orca_k" ] && printf '%s %s\\n' "$_orca_n" "$_orca_k"; done`
}

// Guest side ends itself too: an abandoned wsl.exe must not leave a root scan running.
const GUEST_TIMEOUT_S = 10
const PROBE_TIMEOUT_MS = 15_000

/** One `<name> <public key>` line per account; root reads only regular, non-symlinked, small key files. */
export function wslAccountKeysCommand(passwd = 'getent passwd'): string {
  const script = accountKeysScript(passwd)
  return `if command -v timeout >/dev/null 2>&1; then exec timeout ${GUEST_TIMEOUT_S} sh -c ${quotePosixShell(script)}; fi; ${script}`
}

export const WSL_ACCOUNT_KEYS_COMMAND = wslAccountKeysCommand()

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
  record: WslHostDeploymentRecord,
  /** The name the distro resolves to now (a rename); defaults to the record's. */
  distro = record.distro
): Promise<WslPairedAccount | null> {
  const offer = await resolveEnvironmentPairingOffer(userDataPath, record.environmentId)
  const publicKeyB64 = record.pairingPublicKeyB64 ?? offer?.publicKeyB64
  if (record.linuxUser || !offer || !publicKeyB64) {
    return null
  }
  const { environmentId } = record
  const signal = AbortSignal.timeout(PROBE_TIMEOUT_MS)
  const transport = createWslOrcadHostTransport({
    target: { kind: 'wsl', id: environmentId, distro, label: distro },
    user: 'root',
    commandLoops: false,
    signal
  })
  try {
    const keys = await execCommand(transport, WSL_ACCOUNT_KEYS_COMMAND, { signal })
    const linuxUser = accountHoldingKey(keys, publicKeyB64)
    return linuxUser ? { linuxUser, offer } : null
  } catch (error) {
    console.warn(`[wsl-hosts] Couldn’t look for ${distro}’s paired server account:`, error)
    return null
  } finally {
    transport.dispose()
  }
}

// One trial per host: a second Connect joins it rather than racing the override.
const trials = new Map<string, Promise<void>>()
// A hung connect must not keep the trial's account pinned in memory.
export const PAIRED_ACCOUNT_CONNECT_TIMEOUT_MS = 10 * 60_000

/** Connects as `found.linuxUser` and saves the pin only once that connect verified the server. */
export function connectAsPairedWslAccount(
  userDataPath: string,
  record: WslHostDeploymentRecord,
  found: WslPairedAccount,
  connect: (signal: AbortSignal) => Promise<unknown>,
  persist: (
    ...args: Parameters<typeof refreshWslHostPairing>
  ) => Promise<unknown> = refreshWslHostPairing,
  timeoutMs = PAIRED_ACCOUNT_CONNECT_TIMEOUT_MS
): Promise<void> {
  const pending = trials.get(record.environmentId)
  if (pending) {
    return pending
  }
  const trial = withWslHostLinuxUser(record.distro, found.linuxUser, async () => {
    // Aborting, not just rejecting: once the override ends, no step of the connect may run as the default user.
    const cap = AbortSignal.timeout(timeoutMs)
    await raceAbort(connect(cap), cap, record.distro)
    // The saved pairing is unchanged, so this write only adds the pin.
    await persist(userDataPath, record.environmentId, {
      pairingCode: encodePairingOffer(found.offer),
      localPort: record.localPort,
      remotePort: record.remotePort,
      linuxUser: found.linuxUser
    })
    // Saved, so the next records read keeps it; until then this keeps the holder and liveness on it.
    pinWslHostLinuxUser(record.distro, found.linuxUser)
  }).finally(() => trials.delete(record.environmentId))
  trials.set(record.environmentId, trial)
  return trial
}

async function raceAbort<T>(work: Promise<T>, signal: AbortSignal, distro: string): Promise<T> {
  const aborted = new Promise<never>((_, reject) => {
    const fail = (): void =>
      reject(new Error(`Connecting ${distro} as its paired account took too long.`))
    if (signal.aborted) {
      fail()
    }
    signal.addEventListener('abort', fail, { once: true })
  })
  return await Promise.race([work, aborted])
}

/** Stops as the record's account under `name` (pins are keyed by the record's name); an unpinned changed host is stopped as its paired account. */
export async function stopAsHostAccount<T>(
  userDataPath: string,
  record: WslHostDeploymentRecord,
  name: string,
  stop: () => Promise<T>
): Promise<T> {
  const as = (linuxUser: string | undefined): Promise<T> =>
    linuxUser ? withWslHostLinuxUser(name, linuxUser, stop) : stop()
  try {
    return await as(record.linuxUser)
  } catch (error) {
    const found =
      error instanceof WslHostAccountChangedError && !record.linuxUser
        ? await findPairedWslAccount(userDataPath, record, name)
        : null
    if (!found) {
      throw error
    }
    return as(found.linuxUser)
  }
}
