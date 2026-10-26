// Unreadable host records must not look absent: deploying over an unknown live install is unsafe.
import { randomUUID } from 'node:crypto'
import { quotePosixShell } from '../../../shared/shell-argument-quoting'
import { removeRemoteFileCommand } from '../../ssh/ssh-remote-commands'
import { execOrcadRemote, type OrcadRemoteExecTarget } from './orcad-remote-runtime-control'
import { isUnconfirmedSshCommandTermination } from '../../ssh/remote-exec/remote-exec-command'
import { isWindowsRemoteHost } from '../../ssh/ssh-remote-platform'
import {
  orcadRemoteBaseDir,
  orcadWindowsHostOpCommand,
  readOrcadWindowsEncodedAnswer
} from './orcad-remote-windows-node'
import {
  ORCAD_RECORD_ABSENT_MARKER as ABSENT_MARKER,
  ORCAD_RECORD_PRESENT_MARKER as PRESENT_MARKER
} from '../host-state/orcad-windows-host-script'

/** Callers validate the schema of present records. */
type OrcadRemoteRecordRead = { state: 'absent' } | { state: 'present'; raw: string }

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
  const file = quotePosixShell(path)
  // Explicit markers distinguish absent records from failed reads with empty stdout.
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
      `umask 077; printf %s ${quotePosixShell(contents)} > ${quotePosixShell(partialPath)} && ` +
        `mv -f ${quotePosixShell(partialPath)} ${quotePosixShell(path)}`
    )
  } catch (error) {
    // Unconfirmed writes may still be running; preserve their partial file.
    if (!isUnconfirmedSshCommandTermination(error)) {
      const discard = baseDir
        ? orcadWindowsHostOpCommand(target.host, baseDir, 'remove-file', [partialPath])
        : removeRemoteFileCommand(target.host, partialPath)
      await execOrcadRemote(target, discard).catch(() => {})
    }
    throw error
  }
}
