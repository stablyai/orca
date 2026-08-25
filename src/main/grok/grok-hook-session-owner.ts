import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import {
  readManagedHookHostIdentity,
  readManagedHookProcessIdentity
} from '../agent-hooks/managed-hook-owner-identity'

type GrokHookSessionOwner = {
  pid: number
  hostIdentity: string
  processIdentity: string
}

// Why this exists: the global hook config is removed on quit, but a crash, SIGKILL or power loss
// never reaches that path, and Grok keeps loading the orphaned file on every session — the exact
// bug #15518 reports. Recording who installed the config lets the next launch tell "another live
// Orca owns this" from "the process that wrote this is gone", and clean up in the second case.
// Identity comes from the existing managed-hook owner probe, which qualifies the pid with process
// start time, so a recycled pid cannot masquerade as the previous owner.
export async function readGrokHookSessionOwner(
  ownerPath: string
): Promise<GrokHookSessionOwner | null> {
  try {
    const parsed = JSON.parse(await readFile(ownerPath, 'utf8')) as Partial<GrokHookSessionOwner>
    if (
      !Number.isSafeInteger(parsed.pid) ||
      (parsed.pid ?? 0) <= 0 ||
      typeof parsed.hostIdentity !== 'string' ||
      parsed.hostIdentity.length === 0 ||
      typeof parsed.processIdentity !== 'string' ||
      parsed.processIdentity.length === 0
    ) {
      return null
    }
    return parsed as GrokHookSessionOwner
  } catch {
    return null
  }
}

export async function writeGrokHookSessionOwner(ownerPath: string): Promise<void> {
  const [hostIdentity, processIdentity] = await Promise.all([
    readManagedHookHostIdentity(),
    readManagedHookProcessIdentity(process.pid)
  ])
  if (typeof processIdentity !== 'string') {
    return
  }
  const owner: GrokHookSessionOwner = { pid: process.pid, hostIdentity, processIdentity }
  await mkdir(dirname(ownerPath), { recursive: true })
  // Why a draft plus rename rather than writing in place: a crash mid-write would leave
  // unparseable JSON, which reads as "no owner" and silently disables the reconciliation this
  // record exists to drive. Why wx+0600 on the draft and not mode on the final write: mode applies
  // only on creation, so truncating an existing record would keep whatever mode it already had --
  // and hostIdentity can carry the durable managed-hook host token that lock ownership is keyed on.
  const draftPath = `${ownerPath}.${process.pid}.${randomUUID()}.draft`
  try {
    await writeFile(draftPath, JSON.stringify(owner), {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600
    })
    await rename(draftPath, ownerPath)
  } catch (error) {
    await rm(draftPath, { force: true })
    throw error
  }
}

export async function clearGrokHookSessionOwner(ownerPath: string): Promise<void> {
  await rm(ownerPath, { force: true })
}

/**
 * True only when the recorded owner is provably gone. An unavailable probe returns `undefined` and
 * is treated as "still owned", so an unreadable process table never causes us to delete hooks a
 * live Orca is using.
 */
export async function isGrokHookSessionOwnerStale(owner: GrokHookSessionOwner): Promise<boolean> {
  const hostIdentity = await readManagedHookHostIdentity()
  // Why the runtime: prefix is exempt: with no durable host token (read-only /var/tmp, hardened
  // container) the probe returns a per-process random identity, so a recorded one can never match
  // and reconciliation would be dead on exactly those hosts. The process identity is already
  // boot- and namespace-scoped, so it carries the comparison on its own.
  const hostScopeIsComparable =
    !hostIdentity.startsWith('runtime:') && !owner.hostIdentity.startsWith('runtime:')
  if (hostScopeIsComparable && owner.hostIdentity !== hostIdentity) {
    return false
  }
  const currentIdentity = await readManagedHookProcessIdentity(owner.pid)
  return (
    currentIdentity === null ||
    (typeof currentIdentity === 'string' && currentIdentity !== owner.processIdentity)
  )
}
