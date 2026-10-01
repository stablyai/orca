/**
 * Small JSON records Orca keeps on an orcad host (activation, transactions, stop receipts).
 *
 * Reads are bounded and never swallow a failure: a record that could not be read is not an
 * absent one, and treating it as absent is how a client deploys over a live install.
 */
import { randomUUID } from 'node:crypto'
import { shellEscape } from './ssh-connection-utils'
import { assertPosixOrcadHost } from './orcad-remote-host-support'
import { removeRemoteFileCommand } from './ssh-remote-commands'
import { execOrcadRemote, type OrcadRemoteExecTarget } from './orcad-remote-runtime-control'
import { isUnconfirmedSshCommandTermination } from './ssh-relay-deploy-helpers'

const ABSENT_MARKER = '__ORCAD_RECORD_ABSENT__'
const PRESENT_MARKER = '__ORCAD_RECORD_PRESENT__'

/** `present` carries raw bytes; schema checks belong to the caller that owns the format. */
export type OrcadRemoteRecordRead = { state: 'absent' } | { state: 'present'; raw: string }

export async function readBoundedOrcadRemoteRecord(
  target: OrcadRemoteExecTarget,
  path: string,
  maxBytes: number
): Promise<OrcadRemoteRecordRead> {
  assertPosixOrcadHost(target.host)
  const file = shellEscape(path)
  // Why markers: an empty stdout must never be mistaken for "no record" when the read failed.
  const output = await execOrcadRemote(
    target,
    `if [ ! -e ${file} ] && [ ! -L ${file} ]; then printf '%s\\n' ${ABSENT_MARKER}; exit 0; fi; ` +
      `[ -f ${file} ] || exit 65; size=$(wc -c < ${file}) || exit 65; ` +
      `[ "$size" -le ${maxBytes} ] || exit 65; ` +
      `printf '%s\\n' ${PRESENT_MARKER}; cat ${file}`
  )
  const newline = output.indexOf('\n')
  const marker = (newline === -1 ? output : output.slice(0, newline)).trim()
  if (marker === ABSENT_MARKER) {
    return { state: 'absent' }
  }
  if (marker !== PRESENT_MARKER) {
    throw new Error('orcad host record read returned no verifiable answer')
  }
  return { state: 'present', raw: newline === -1 ? '' : output.slice(newline + 1) }
}

export async function writeAtomicOrcadRemoteRecord(
  target: OrcadRemoteExecTarget,
  path: string,
  contents: string
): Promise<void> {
  assertPosixOrcadHost(target.host)
  const partialPath = `${path}.partial.${process.pid}.${randomUUID()}`
  try {
    await execOrcadRemote(
      target,
      `umask 077; printf %s ${shellEscape(contents)} > ${shellEscape(partialPath)} && ` +
        `mv -f ${shellEscape(partialPath)} ${shellEscape(path)}`
    )
  } catch (error) {
    // Why keep the partial on an unconfirmed termination: the write may still be running there.
    if (!isUnconfirmedSshCommandTermination(error)) {
      await execOrcadRemote(target, removeRemoteFileCommand(target.host, partialPath)).catch(
        () => {}
      )
    }
    throw error
  }
}
