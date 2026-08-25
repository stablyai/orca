import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import {
  readManagedHookHostIdentity,
  readManagedHookProcessIdentity
} from '../agent-hooks/managed-hook-owner-identity'

const OWNERS_VERSION = 1

// Why memoized: describeSelf() is consulted once per recorded owner while pruning, and the identity
// probe forks a subprocess on macOS and Windows. Without this a prune costs O(owners) spawns.
// Self identity cannot change within a process, so one probe is authoritative for its lifetime.
let selfOwnerPromise: Promise<GrokHookSessionOwner> | undefined

// Why a fallback identity for THIS process: the probe forks `ps` on macOS with a short timeout, so
// a loaded machine returns "could not tell" and we would record no owner at all -- leaving crash
// reconciliation inert exactly when it is most likely to be needed. Windows already falls back this
// way for self. A runtime-scoped identity can never be matched by a later process, so a record
// carrying one is treated as never-provably-stale: conservative, never destructive.
const selfRuntimeIdentity = `runtime:${randomUUID()}`

type GrokHookSessionOwner = {
  pid: number
  /** 'runtime' means the host probe was unavailable, so the scope cannot be compared. */
  hostScope: 'durable' | 'runtime'
  hostDigest: string
  processIdentity: string
}

type GrokHookSessionOwners = {
  version: number
  owners: GrokHookSessionOwner[]
}

// Why a LIST and not one slot: two Orcas can share one $GROK_HOME (packaged and dev do not share
// the single-instance lock), and a single slot cannot express "someone else still needs this".
// With one slot the first instance to quit deletes the config out from under every other live
// instance. Owners are pruned against the process table on every read, so a crashed instance drops
// out on its own and never pins the config.
export async function readGrokHookSessionOwners(
  ownersPath: string
): Promise<GrokHookSessionOwner[]> {
  try {
    const parsed = JSON.parse(await readFile(ownersPath, 'utf8')) as Partial<GrokHookSessionOwners>
    if (parsed.version !== OWNERS_VERSION || !Array.isArray(parsed.owners)) {
      return []
    }
    return parsed.owners.filter(isWellFormedOwner)
  } catch {
    return []
  }
}

/** Owners that are not provably gone. An unavailable probe counts as still-live, never as stale. */
export async function readLiveGrokHookSessionOwners(
  ownersPath: string
): Promise<GrokHookSessionOwner[]> {
  const owners = await readGrokHookSessionOwners(ownersPath)
  const live = await Promise.all(
    owners.map(async (owner) => ((await isStale(owner)) ? null : owner))
  )
  return live.filter((owner): owner is GrokHookSessionOwner => owner !== null)
}

export async function claimGrokHookSession(ownersPath: string): Promise<void> {
  const self = await describeSelf()
  const live = await readLiveGrokHookSessionOwners(ownersPath)
  const others = live.filter((owner) => owner.pid !== self.pid)
  await writeOwners(ownersPath, [...others, self])
}

/** Drops this process from the record. Returns true when no other live owner remains. */
export async function releaseGrokHookSession(ownersPath: string): Promise<boolean> {
  const live = await readLiveGrokHookSessionOwners(ownersPath)
  const others = live.filter((owner) => owner.pid !== process.pid)
  if (others.length === 0) {
    await rm(ownersPath, { force: true })
    return true
  }
  await writeOwners(ownersPath, others)
  return false
}

export async function clearGrokHookSessionOwners(ownersPath: string): Promise<void> {
  await rm(ownersPath, { force: true })
}

async function writeOwners(ownersPath: string, owners: GrokHookSessionOwner[]): Promise<void> {
  await mkdir(dirname(ownersPath), { recursive: true })
  // Why draft+rename: writing in place would leave unparseable JSON after a crash mid-write, which
  // reads as "nobody owns this" and silently disables reconciliation. rename also replaces the
  // inode, so 0600 applies even when an older record already exists (mode only applies on create).
  const draftPath = `${ownersPath}.${process.pid}.${randomUUID()}.draft`
  try {
    const payload: GrokHookSessionOwners = { version: OWNERS_VERSION, owners }
    await writeFile(draftPath, JSON.stringify(payload), {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600
    })
    await rename(draftPath, ownersPath)
  } catch (error) {
    await rm(draftPath, { force: true })
    throw error
  }
}

async function describeSelf(): Promise<GrokHookSessionOwner> {
  return await (selfOwnerPromise ??= probeSelf())
}

async function probeSelf(): Promise<GrokHookSessionOwner> {
  const [hostIdentity, processIdentity] = await Promise.all([
    readManagedHookHostIdentity(),
    readManagedHookProcessIdentity(process.pid)
  ])
  return {
    pid: process.pid,
    hostScope: hostIdentity.startsWith('runtime:') ? 'runtime' : 'durable',
    // Why a digest: hostIdentity can carry the durable managed-hook host token that lock ownership
    // is keyed on, and staleness only ever compares it for equality.
    hostDigest: createHash('sha256').update(hostIdentity).digest('hex'),
    processIdentity: typeof processIdentity === 'string' ? processIdentity : selfRuntimeIdentity
  }
}

async function isStale(owner: GrokHookSessionOwner): Promise<boolean> {
  const self = await describeSelf()
  // Why short-circuit self: describeSelf is memoized, so answering from it costs no probe at all.
  if (owner.pid === process.pid) {
    return owner.processIdentity !== self.processIdentity
  }
  // Why attribute the record to a host first: pids do not carry across machines, so a record from
  // another host is absent from OUR process table as a matter of course. Pruning on that would let
  // one host delete a config another host is actively using whenever HOME is shared (NFS, a shared
  // container volume). We cannot observe a foreign process table, and loss of contact is not
  // evidence of death -- so a foreign record is left alone and its own host cleans it up.
  const sameHostScope =
    owner.hostScope === 'runtime' ||
    self.hostScope === 'runtime' ||
    self.hostDigest === owner.hostDigest
  if (!sameHostScope) {
    return false
  }
  const currentIdentity = await readManagedHookProcessIdentity(owner.pid)
  // Why liveness before the identity comparison: a confirmed-absent process is gone whatever its
  // identity looked like. Checking comparability first made a runtime-scoped record unprunable,
  // and since any surviving owner blocks removal, one such record left by a crash disabled
  // quit-time removal and reconciliation permanently.
  if (currentIdentity === null) {
    return true
  }
  // Why not stale below here: a runtime-scoped identity is a fresh random value per process, so it
  // can never match a recorded one, and `undefined` means the probe could not answer. Neither is
  // evidence of death, and treating either as death deletes a live Orca's hooks.
  if (owner.hostScope === 'runtime' || owner.processIdentity.startsWith('runtime:')) {
    return false
  }
  return typeof currentIdentity === 'string' && currentIdentity !== owner.processIdentity
}

function isWellFormedOwner(value: unknown): value is GrokHookSessionOwner {
  const owner = value as Partial<GrokHookSessionOwner> | null
  return (
    !!owner &&
    Number.isSafeInteger(owner.pid) &&
    (owner.pid ?? 0) > 0 &&
    (owner.hostScope === 'durable' || owner.hostScope === 'runtime') &&
    typeof owner.hostDigest === 'string' &&
    owner.hostDigest.length > 0 &&
    typeof owner.processIdentity === 'string' &&
    owner.processIdentity.length > 0
  )
}
