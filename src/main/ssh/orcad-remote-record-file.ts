/**
 * Small JSON records Orca keeps on an orcad host (activation, transactions, stop receipts).
 *
 * Reads are bounded and never swallow a failure: a record that could not be read is not an
 * absent one, and treating it as absent is how a client deploys over a live install.
 */
import { randomUUID } from 'node:crypto'
import { shellEscape } from './ssh-connection-utils'
import { removeRemoteFileCommand } from './ssh-remote-commands'
import { execOrcadRemote, type OrcadRemoteExecTarget } from './orcad-remote-runtime-control'
import { isUnconfirmedSshCommandTermination } from './ssh-relay-deploy-helpers'
import { isWindowsRemoteHost } from './ssh-remote-platform'
import {
  orcadRemoteBaseDir,
  orcadWindowsHostOpCommand,
  readOrcadWindowsEncodedAnswer
} from './orcad-remote-windows-node'
import {
  ORCAD_RECORD_ABSENT_MARKER as ABSENT_MARKER,
  ORCAD_RECORD_PRESENT_MARKER as PRESENT_MARKER
} from './orcad-windows-host-script'

/** `present` carries raw bytes; schema checks belong to the caller that owns the format. */
export type OrcadRemoteRecordRead = { state: 'absent' } | { state: 'present'; raw: string }

/** `~/.orca-remote`, where the host script and the pinned runtime live. */
function windowsBaseDir(target: OrcadRemoteExecTarget): string {
  if (!target.remoteHome) {
    throw new Error(
      'orcad host records on Windows need the remote home to find the pinned node.exe'
    )
  }
  return orcadRemoteBaseDir(target.host, target.remoteHome)
}

export async function readBoundedOrcadRemoteRecord(
  target: OrcadRemoteExecTarget,
  path: string,
  maxBytes: number
): Promise<OrcadRemoteRecordRead> {
  if (isWindowsRemoteHost(target.host)) {
    return readWindowsRecord(target, path, maxBytes)
  }
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

async function readWindowsRecord(
  target: OrcadRemoteExecTarget,
  path: string,
  maxBytes: number
): Promise<OrcadRemoteRecordRead> {
  const output = await execOrcadRemote(
    target,
    orcadWindowsHostOpCommand(target.host, windowsBaseDir(target), 'record-read', [
      path,
      String(maxBytes)
    ])
  )
  if (output.split(/\r?\n/u).some((line) => line.trim() === ABSENT_MARKER)) {
    return { state: 'absent' }
  }
  const raw = readOrcadWindowsEncodedAnswer(output, PRESENT_MARKER)
  if (raw === null) {
    throw new Error('orcad host record read returned no verifiable answer')
  }
  return { state: 'present', raw }
}

export async function writeAtomicOrcadRemoteRecord(
  target: OrcadRemoteExecTarget,
  path: string,
  contents: string
): Promise<void> {
  const partialPath = `${path}.partial.${process.pid}.${randomUUID()}`
  const baseDir = isWindowsRemoteHost(target.host) ? windowsBaseDir(target) : null
  try {
    if (baseDir) {
      await target.conn.writeFile(partialPath, contents, {
        hostPlatform: target.host,
        signal: target.signal
      })
      await execOrcadRemote(
        target,
        orcadWindowsHostOpCommand(target.host, baseDir, 'record-publish', [partialPath, path])
      )
      return
    }
    await execOrcadRemote(
      target,
      `umask 077; printf %s ${shellEscape(contents)} > ${shellEscape(partialPath)} && ` +
        `mv -f ${shellEscape(partialPath)} ${shellEscape(path)}`
    )
  } catch (error) {
    // Why keep the partial on an unconfirmed termination: the write may still be running there.
    if (!isUnconfirmedSshCommandTermination(error)) {
      const discard = baseDir
        ? orcadWindowsHostOpCommand(target.host, baseDir, 'remove-file', [partialPath])
        : removeRemoteFileCommand(target.host, partialPath)
      await execOrcadRemote(target, discard).catch(() => {})
    }
    throw error
  }
}
