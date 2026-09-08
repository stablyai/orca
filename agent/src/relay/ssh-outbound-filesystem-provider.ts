// src/relay/ssh-outbound-filesystem-provider.ts
// TASK-AG-EVM-007/SOL-AG-EVM-003 §2c: reads filesystem data from a hidden
// target — a host this agent dialed OUT to (TASK-AG-EVM-005's
// dialOutboundSshTarget), registered under `hiddenTargetRegistry`
// (TASK-AG-EVM-006) — using ssh2's SFTP subsystem directly on the dialed
// OutboundSshSession. Data direction is the OPPOSITE of
// ssh-filesystem-stream-reader.ts (which reads a channel Orca opened INTO
// this agent) — mirrors that module's architecture only ("eventually reads
// fs over SSH"), not its code, per SOL-AG-EVM-003 §2c's explicit note.
//
// RPC method names (confirm against backend-go's TASK-BE-EVM-015 before
// relying on these from the backend side): `fs.readDirViaHiddenTarget`,
// `fs.readFileViaHiddenTarget` — see agent-rpc-dispatch-misc.ts's cases.
import type { SFTPWrapper, FileEntryWithStats } from 'ssh2'
import { hiddenTargetRegistry } from './agent-ephemeral-vm-handler'
import type { OutboundSshSession } from './ssh-outbound-client'

export type HiddenTargetDirEntry = {
  name: string
  type: 'file' | 'directory' | 'symlink' | 'other'
}

export type ReadDirViaHiddenTargetParams = { hiddenTargetId: string; path: string }
export type ReadFileViaHiddenTargetParams = { hiddenTargetId: string; path: string }

function requiredStringField(
  params: Record<string, unknown>,
  name: string,
  method: string
): string {
  const value = params[name]
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${method}: missing required param "${name}"`)
  }
  return value
}

export function validateReadDirViaHiddenTargetParams(
  params: unknown
): ReadDirViaHiddenTargetParams {
  const p = (params ?? {}) as Record<string, unknown>
  return {
    hiddenTargetId: requiredStringField(p, 'hiddenTargetId', 'fs.readDirViaHiddenTarget'),
    path: requiredStringField(p, 'path', 'fs.readDirViaHiddenTarget')
  }
}

export function validateReadFileViaHiddenTargetParams(
  params: unknown
): ReadFileViaHiddenTargetParams {
  const p = (params ?? {}) as Record<string, unknown>
  return {
    hiddenTargetId: requiredStringField(p, 'hiddenTargetId', 'fs.readFileViaHiddenTarget'),
    path: requiredStringField(p, 'path', 'fs.readFileViaHiddenTarget')
  }
}

// Why a dedicated lookup helper (not inlined at each call site): both
// providers (this file and ssh-outbound-git-provider.ts) need the exact
// same "no session for this id" error text/behavior — a hidden target that
// was never dialed, or whose agent process restarted since (SOL-AG-EVM-003
// mục 3 — sessions are in-memory only, never survive a restart).
export function lookupHiddenTargetSession(hiddenTargetId: string): OutboundSshSession {
  const session = hiddenTargetRegistry.get(hiddenTargetId)
  if (!session) {
    throw new Error(
      `No hidden target session for id "${hiddenTargetId}" — it was never dialed via ` +
        `vm.sshDial, or the agent restarted since (hidden target sessions are in-memory ` +
        `only, per SOL-AG-EVM-003 mục 3)`
    )
  }
  return session
}

function openSftp(session: OutboundSshSession): Promise<SFTPWrapper> {
  return new Promise((resolve, reject) => {
    session.client.sftp((err, sftp) => {
      if (err) {
        reject(err)
        return
      }
      resolve(sftp)
    })
  })
}

function fileEntryType(entry: FileEntryWithStats): HiddenTargetDirEntry['type'] {
  if (entry.attrs.isDirectory()) {
    return 'directory'
  }
  if (entry.attrs.isSymbolicLink()) {
    return 'symlink'
  }
  if (entry.attrs.isFile()) {
    return 'file'
  }
  return 'other'
}

export async function readDirViaHiddenTarget(
  params: ReadDirViaHiddenTargetParams
): Promise<{ entries: HiddenTargetDirEntry[] }> {
  const session = lookupHiddenTargetSession(params.hiddenTargetId)
  const sftp = await openSftp(session)
  const list = await new Promise<FileEntryWithStats[]>((resolve, reject) => {
    sftp.readdir(params.path, (err, entries) => {
      if (err) {
        reject(err)
        return
      }
      resolve(entries)
    })
  })
  return {
    entries: list
      .filter((entry) => entry.filename !== '.' && entry.filename !== '..')
      .map((entry) => ({ name: entry.filename, type: fileEntryType(entry) }))
  }
}

export async function readFileViaHiddenTarget(
  params: ReadFileViaHiddenTargetParams
): Promise<{ content: string; encoding: 'base64' }> {
  const session = lookupHiddenTargetSession(params.hiddenTargetId)
  const sftp = await openSftp(session)
  const buffer = await new Promise<Buffer>((resolve, reject) => {
    sftp.readFile(params.path, (err, data) => {
      if (err) {
        reject(err)
        return
      }
      resolve(data)
    })
  })
  // Why base64 always (not the local fs.readFile's utf-8-unless-binary
  // convention): a hidden target's SFTP read has no cheap local binary
  // sniff step already done for it — base64 is always correct for
  // arbitrary file content and keeps this provider simple; a richer
  // encoding-detection pass is out of this task's scope.
  return { content: buffer.toString('base64'), encoding: 'base64' }
}
