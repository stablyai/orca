/**
 * Why: a host cloned from an image (VM template, WSL export) carries the same
 * `orca-e2ee-keypair.json`, and every service that names a host by that key (push gateway, relay,
 * pairing) would then treat the clones as one host. The key records a tag of the machine it was
 * minted on, and a different machine mints its own.
 *
 * Linux only, and never in a container or on a network disk: containers bake or regenerate
 * machine-id per image build, and shared homes (NFS) are shared by design. Known cost: on WSL the
 * tag includes the Windows computer name, so renaming the PC replaces the key.
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { orcadDataRootIsOnLocalDisk } from '../orcad/orcad-data-root-locality'
import { profileStateAccessMachineIdentity } from '../persistence/profile-state/profile-state-access-identity'

export type E2EEKeyHostSignals = {
  platform: NodeJS.Platform
  dataRootOnLocalDisk: boolean
  inContainer: boolean
  machineId: string | null
  isWsl: boolean
  hostname: string
}

function readLinuxKernelRelease(): string {
  try {
    return readFileSync('/proc/sys/kernel/osrelease', 'utf8')
  } catch {
    return ''
  }
}

export function readE2EEKeyHostSignals(userDataPath: string): E2EEKeyHostSignals {
  const platform = process.platform
  if (platform !== 'linux') {
    return {
      platform,
      dataRootOnLocalDisk: false,
      inContainer: false,
      machineId: null,
      isWsl: false,
      hostname: ''
    }
  }
  return {
    platform,
    dataRootOnLocalDisk: orcadDataRootIsOnLocalDisk(userDataPath, platform),
    inContainer: existsSync('/.dockerenv') || existsSync('/run/.containerenv'),
    machineId: profileStateAccessMachineIdentity(),
    // A custom WSL kernel may not say "microsoft"; the interop registration is WSL's own.
    isWsl:
      /microsoft/i.test(readLinuxKernelRelease()) ||
      existsSync('/proc/sys/fs/binfmt_misc/WSLInterop'),
    hostname: hostname().trim()
  }
}

/** The tag a key minted here records, or null when this host has no trustworthy identity. */
export function e2eeKeyHostBinding(signals: E2EEKeyHostSignals): string | null {
  if (
    signals.platform !== 'linux' ||
    !signals.dataRootOnLocalDisk ||
    signals.inContainer ||
    !signals.machineId
  ) {
    return null
  }
  // WSL: an exported distro keeps its machine-id, but the hostname is the Windows computer's.
  if (signals.isWsl && !signals.hostname) {
    return null
  }
  const parts = signals.isWsl
    ? ['wsl', signals.hostname, signals.machineId]
    : ['linux', signals.machineId]
  // Hashed so the key file never carries the raw machine-id.
  return createHash('sha256')
    .update(['orca-e2ee-host-binding-v1', ...parts].join('\0'))
    .digest('base64url')
    .slice(0, 22)
}
