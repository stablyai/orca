import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, readlink, rename, rmdir } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type { CliInstallStatus } from '../../shared/cli-install-types'
import { isMissingError } from './cli-install-errors'
import { quoteShell } from './cli-install-path-format'

export type EntryIdentity = {
  dev: bigint
  ino: bigint
  mode: bigint
  size: bigint
  ctimeNs: bigint
}

export type EntrySnapshot = { identity: EntryIdentity; isSymbolicLink: boolean }
export type CommandQuarantine = {
  directoryPath: string
  heldPath: string
  snapshot: EntrySnapshot | null
}
export type StableCommandInspection = {
  fileSha256: string | null
  rawSymlinkTarget: string | null
  snapshot: EntrySnapshot | null
  status: CliInstallStatus
}

const STABLE_INSPECTION_ATTEMPTS = 3

export async function readEntrySnapshot(path: string): Promise<EntrySnapshot | null> {
  try {
    const stats = await lstat(path, { bigint: true })
    return {
      identity: {
        dev: stats.dev,
        ino: stats.ino,
        mode: stats.mode,
        size: stats.size,
        ctimeNs: stats.ctimeNs
      },
      isSymbolicLink: stats.isSymbolicLink()
    }
  } catch (error) {
    if (isMissingError(error)) {
      return null
    }
    throw error
  }
}

export function hasSameIdentity(left: EntryIdentity | null, right: EntryIdentity | null): boolean {
  return (
    left === right ||
    (left !== null && right !== null && left.dev === right.dev && left.ino === right.ino)
  )
}

export function hasSameSnapshot(left: EntrySnapshot | null, right: EntrySnapshot | null): boolean {
  return (
    left === right ||
    (left !== null &&
      right !== null &&
      hasSameIdentity(left.identity, right.identity) &&
      left.identity.mode === right.identity.mode &&
      left.identity.size === right.identity.size &&
      left.identity.ctimeNs === right.identity.ctimeNs)
  )
}

export async function hashCommandFile(path: string): Promise<string> {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex')
}

export async function inspectStableCommand(
  commandPath: string,
  inspect: () => Promise<CliInstallStatus>
): Promise<StableCommandInspection> {
  for (let attempt = 0; attempt < STABLE_INSPECTION_ATTEMPTS; attempt += 1) {
    const before = await readEntrySnapshot(commandPath)
    const status = await inspect()
    const afterInspection = await readEntrySnapshot(commandPath)
    if (
      !hasSameSnapshot(before, afterInspection) ||
      (afterInspection === null) !== (status.state === 'not_installed')
    ) {
      continue
    }
    let fileSha256: string | null = null
    let rawSymlinkTarget: string | null = null
    try {
      if (afterInspection?.isSymbolicLink) {
        rawSymlinkTarget = await readlink(commandPath)
      } else if (afterInspection && status.state !== 'conflict') {
        fileSha256 = await hashCommandFile(commandPath)
      }
    } catch {
      continue
    }
    const afterEvidence = await readEntrySnapshot(commandPath)
    if (hasSameSnapshot(afterInspection, afterEvidence)) {
      return { fileSha256, rawSymlinkTarget, snapshot: afterEvidence, status }
    }
  }
  throw new Error(`The command at ${commandPath} changed while Orca inspected it.`)
}

export async function quarantineCommandPath(commandPath: string): Promise<CommandQuarantine> {
  const commandDirectory = dirname(commandPath)
  const directoryPath = join(commandDirectory, `.orca-cli-${process.pid}-${randomUUID()}`)
  const heldPath = join(directoryPath, basename(commandPath))
  await mkdir(commandDirectory, { recursive: true })
  await mkdir(directoryPath, { mode: 0o700 })
  try {
    await rename(commandPath, heldPath)
  } catch (error) {
    if (!isMissingError(error)) {
      await rmdir(directoryPath).catch(() => undefined)
      throw error
    }
  }
  return { directoryPath, heldPath, snapshot: await readEntrySnapshot(heldPath) }
}

export async function capturedExpectedEntry(
  quarantine: CommandQuarantine,
  inspected: Pick<StableCommandInspection, 'fileSha256' | 'rawSymlinkTarget' | 'snapshot'>
): Promise<boolean> {
  if (!quarantine.snapshot) {
    return true
  }
  if (
    !inspected.snapshot ||
    quarantine.snapshot.isSymbolicLink !== inspected.snapshot.isSymbolicLink ||
    !hasSameIdentity(quarantine.snapshot.identity, inspected.snapshot.identity)
  ) {
    return false
  }
  if (inspected.rawSymlinkTarget !== null) {
    try {
      return (await readlink(quarantine.heldPath)) === inspected.rawSymlinkTarget
    } catch {
      return false
    }
  }
  if (!inspected.fileSha256) {
    return true
  }
  try {
    return (await hashCommandFile(quarantine.heldPath)) === inspected.fileSha256
  } catch {
    return false
  }
}

type MacPrivilegedSymlinkTransaction = {
  commandPath: string
  expected: EntryIdentity | null
  expectedFileSha256: string | null
  expectedRawSymlinkTarget: string | null
} & ({ action: 'install'; launcherPath: string } | { action: 'remove' })

export function buildMacPrivilegedSymlinkTransaction(
  args: MacPrivilegedSymlinkTransaction
): string {
  const commandDirectory = dirname(args.commandPath)
  const transactionDirectory = join(commandDirectory, `.orca-cli-${process.pid}-${randomUUID()}`)
  const heldPath = join(transactionDirectory, basename(args.commandPath))
  const publishDirectory = join(transactionDirectory, 'publish')
  const publishPath = join(publishDirectory, basename(args.commandPath))
  const recoveryMessage = quoteShell(`The displaced entry is preserved at ${heldPath}.`)
  const restore =
    `/bin/ln -P ${quoteShell(heldPath)} ${quoteShell(commandDirectory)} && ` +
    `/bin/rm ${quoteShell(heldPath)} && /bin/rmdir ${quoteShell(transactionDirectory)}`
  const restoreOrPreserve = `if ${restore}; then :; else echo ${recoveryMessage} >&2; exit 74; fi`
  const fileMismatch = args.expectedFileSha256
    ? ` || [ "$(/usr/bin/shasum -a 256 ${quoteShell(heldPath)} | /usr/bin/awk '{print $1}')" != ${quoteShell(args.expectedFileSha256)} ]`
    : ''
  const symlinkMismatch = args.expectedRawSymlinkTarget
    ? ` || [ "$(/usr/bin/readlink -n ${quoteShell(heldPath)}; /usr/bin/printf x)" != ${quoteShell(`${args.expectedRawSymlinkTarget}x`)} ]`
    : ''
  const rejectCaptured = args.expected
    ? `if [ "$captured" -eq 1 ] && { [ "$(/usr/bin/stat -f '%d:%i' ${quoteShell(heldPath)})" != ${quoteShell(`${args.expected.dev}:${args.expected.ino}`)} ]${fileMismatch}${symlinkMismatch}; }; then ${restoreOrPreserve}; exit 73; fi`
    : `if [ "$captured" -eq 1 ]; then ${restoreOrPreserve}; exit 73; fi`
  const capture =
    `umask 077; /bin/mkdir -p ${quoteShell(commandDirectory)} || exit $?; ` +
    `/bin/mkdir ${quoteShell(transactionDirectory)} || exit $?; captured=0; ` +
    `if [ -e ${quoteShell(args.commandPath)} ] || [ -L ${quoteShell(args.commandPath)} ]; then ` +
    `/bin/mv ${quoteShell(args.commandPath)} ${quoteShell(heldPath)} && captured=1 || exit $?; fi; ` +
    `${rejectCaptured}; `

  if (args.action === 'remove') {
    return `${capture}if [ "$captured" -eq 1 ]; then /bin/rm ${quoteShell(heldPath)}; fi; /bin/rmdir ${quoteShell(transactionDirectory)}`
  }

  const rollback =
    `/bin/rm -f ${quoteShell(publishPath)}; /bin/rmdir ${quoteShell(publishDirectory)} 2>/dev/null || :; ` +
    `if [ "$captured" -eq 1 ]; then ${restoreOrPreserve}; else /bin/rmdir ${quoteShell(transactionDirectory)}; fi; exit 73`
  return (
    `${capture}if /bin/mkdir ${quoteShell(publishDirectory)} && ` +
    `/bin/ln -s ${quoteShell(args.launcherPath)} ${quoteShell(publishPath)} && ` +
    `/bin/ln -P ${quoteShell(publishPath)} ${quoteShell(commandDirectory)}; then ` +
    `/bin/rm ${quoteShell(publishPath)}; /bin/rmdir ${quoteShell(publishDirectory)}; ` +
    `if [ "$captured" -eq 1 ]; then /bin/rm ${quoteShell(heldPath)}; fi; ` +
    `/bin/rmdir ${quoteShell(transactionDirectory)}; else ${rollback}; fi`
  )
}
