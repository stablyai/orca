import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
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
  // Why 0600: hostIdentity can carry the durable managed-hook host token, which lock ownership is
  // keyed on. ~/.grok/hooks is not otherwise restricted, so keep the record owner-readable only.
  await writeFile(ownerPath, JSON.stringify(owner), { encoding: 'utf8', mode: 0o600 })
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
  if (owner.hostIdentity !== (await readManagedHookHostIdentity())) {
    return false
  }
  const currentIdentity = await readManagedHookProcessIdentity(owner.pid)
  return (
    currentIdentity === null ||
    (typeof currentIdentity === 'string' && currentIdentity !== owner.processIdentity)
  )
}
