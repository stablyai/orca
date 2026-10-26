// ORCA_MACHINE_NAME separates hosts that share a home and a cloned machine-id (#32918).
import { createHash } from 'node:crypto'
import { ORCA_MACHINE_NAME_ENV } from '../../../shared/orcad-managed-launch-env'
import type { RemoteHostPlatform } from '../../ssh/ssh-remote-platform'
import type { OrcadMachineHomeDecision } from './orcad-machine-home'

const MACHINE_NAME_PREFIX = `${ORCA_MACHINE_NAME_ENV}=`
const MACHINE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u

/** Probe line for the hostname section; brackets keep spaces and newlines become spaces, so both are refused. */
export const ORCAD_MACHINE_NAME_PROBE = `printf '${MACHINE_NAME_PREFIX}[%s]\\n' "$(printf %s "\${${ORCA_MACHINE_NAME_ENV}-}" | tr '\\n' ' ')";`

export function parseOrcadMachineNameProbe(lines: readonly string[]): {
  machineName: string | null
} {
  const value = lines
    .find((candidate) => candidate.startsWith(MACHINE_NAME_PREFIX))
    ?.slice(MACHINE_NAME_PREFIX.length)
  // An unset or empty name means none; anything else must validate.
  return {
    machineName: value?.startsWith('[') && value.endsWith(']') ? value.slice(1, -1) || null : null
  }
}

export function machineKeyOf(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 16)
}

/** A name always selects the same home, so it never flips with whatever happens to be running. */
export function namedMachineHome(host: RemoteHostPlatform, name: string): OrcadMachineHomeDecision {
  if (!MACHINE_NAME.test(name)) {
    throw new Error(
      `${ORCA_MACHINE_NAME_ENV} is set to "${name.slice(0, 80)}", which Orca can't use. Use 1-64 ` +
        "letters, digits, '.', '_' or '-', starting with a letter or digit, then reconnect."
    )
  }
  return { kind: 'machine-home', machineKey: machineKeyOf(`${host.os}:name:${name}`) }
}
