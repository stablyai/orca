import { randomUUID } from 'node:crypto'
import { shellEscape } from '../../ssh/ssh-connection-utils'
import { RELAY_REMOTE_DIR } from '../../ssh/remote-exec/remote-frame-protocol'
import {
  ORCAD_MACHINE_CLAIM_FILENAME,
  ORCAD_MACHINE_CLAIM_SCHEMA_VERSION
} from './orcad-machine-home'
import { joinRemotePath, type RemoteHostPlatform } from '../../ssh/ssh-remote-platform'

/** Under `~/.orca-remote`: decides the claim when hard links cannot (see the claim command). */
export const ORCAD_MACHINE_CLAIM_ARBITER_DIRNAME = 'orcad-machine.arbiter'

/**
 * Publishes the claim exclusively and prints whichever claim won. Why a hard link: `ln` is atomic
 * and exclusive on NFS too, and a reader never sees a half-written claim. Where `ln` cannot decide
 * (no hard links, or an empty claim a full disk left), a directory rename picks the winner: it is
 * atomic everywhere, and the arbiter arrives already holding the winner's claim, so a crash leaves
 * no half-taken lock. Every machine then republishes that same claim, so concurrent writes agree.
 */
export function orcadMachineClaimCommand(
  host: RemoteHostPlatform,
  loginHome: string,
  machineKey: string
): string {
  const remoteDir = (...parts: string[]): string =>
    shellEscape(joinRemotePath(host, loginHome, RELAY_REMOTE_DIR, ...parts))
  const attempt = randomUUID()
  const base = remoteDir()
  const claim = remoteDir(ORCAD_MACHINE_CLAIM_FILENAME)
  const partial = remoteDir(`${ORCAD_MACHINE_CLAIM_FILENAME}.partial.${attempt}`)
  const stageName = `${ORCAD_MACHINE_CLAIM_ARBITER_DIRNAME}.partial.${attempt}`
  const stage = remoteDir(stageName)
  const stageClaim = remoteDir(stageName, ORCAD_MACHINE_CLAIM_FILENAME)
  const arbiter = remoteDir(ORCAD_MACHINE_CLAIM_ARBITER_DIRNAME)
  const arbiterClaim = remoteDir(ORCAD_MACHINE_CLAIM_ARBITER_DIRNAME, ORCAD_MACHINE_CLAIM_FILENAME)
  // `mv` into an existing arbiter nests the stage inside it instead of replacing it.
  const nestedStage = remoteDir(ORCAD_MACHINE_CLAIM_ARBITER_DIRNAME, stageName)
  const body = shellEscape(
    JSON.stringify({
      schemaVersion: ORCAD_MACHINE_CLAIM_SCHEMA_VERSION,
      machineKey
    })
  )
  return [
    `umask 077; mkdir -p ${base} || exit 65;`,
    `printf %s ${body} > ${partial} || exit 65;`,
    // Once an arbiter exists it decides any claim that later goes missing or empty.
    `if { [ -d ${arbiter} ] || ! ln ${partial} ${claim} 2>/dev/null; } && [ ! -s ${claim} ]; then`,
    `{ mkdir ${stage} && printf %s ${body} > ${stageClaim}; } || { rm -rf ${stage} ${partial}; exit 65; };`,
    `mv ${stage} ${arbiter} 2>/dev/null; rm -rf ${stage} ${nestedStage};`,
    `[ -s ${arbiterClaim} ] && cat ${arbiterClaim} > ${partial} || { rm -f ${partial}; exit 65; };`,
    `[ -s ${claim} ] || mv -f ${partial} ${claim};`,
    `fi; rm -f ${partial}; cat ${claim}`
  ].join(' ')
}
