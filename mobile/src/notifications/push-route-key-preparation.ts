import * as ExpoCrypto from 'expo-crypto'
import nacl from 'tweetnacl'
import {
  readPairingKeychainItem,
  writePairingKeychainItemIfCurrent
} from '../transport/pairing-keychain'
import { decodeBase64Bytes, encodeBase64Bytes } from '../transport/base64-byte-codec'

const KEY = 'orca.push-route-key'
type KeyObservation =
  | { status: 'present'; keypair: nacl.SignKeyPair }
  | { status: 'missing' | 'unavailable' }
type KeyResult =
  | { status: 'ready'; keypair: nacl.SignKeyPair }
  | { status: 'unavailable' | 'retired' }
export type RouteKeyPreparation = {
  readonly result: Promise<
    { status: 'ready'; routeKey: string } | { status: 'unavailable' | 'retired' }
  >
  release(): void
}
type Authority = { current?: () => boolean }
type KeyEntry = {
  ensure: boolean
  current?: () => boolean
  resolve?: (result: KeyResult) => void
  authority?: Authority
}
type KeyTask = { authority?: Authority }
let committedKey: nacl.SignKeyPair | undefined
const keyEntries = new Set<KeyEntry>()
let keyTask: KeyTask | undefined
function base64url(bytes: Uint8Array): string {
  return encodeBase64Bytes(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
async function observeRouteKey(): Promise<KeyObservation> {
  if (committedKey) {
    return { status: 'present', keypair: committedKey }
  }
  try {
    const stored = await readPairingKeychainItem(KEY)
    if (stored === null) {
      return { status: 'missing' }
    }
    const bytes = decodeBase64Bytes(stored)
    if (bytes.length !== 64) {
      return { status: 'unavailable' }
    }
    committedKey = nacl.sign.keyPair.fromSecretKey(bytes)
    return { status: 'present', keypair: committedKey }
  } catch {
    return { status: 'unavailable' }
  }
}
function finishKey(entry: KeyEntry, result: KeyResult): void {
  keyEntries.delete(entry)
  if (entry.authority) {
    entry.authority.current = undefined
  }
  const resolve = entry.resolve
  entry.current = undefined
  entry.resolve = undefined
  entry.authority = undefined
  resolve?.(result)
}
function completeKeyCohort(observed: KeyObservation): void {
  for (const entry of keyEntries) {
    if (!entry.current?.()) {
      finishKey(entry, { status: 'retired' })
    } else if (observed.status === 'present') {
      finishKey(entry, { status: 'ready', keypair: observed.keypair })
    } else if (observed.status === 'unavailable' || !entry.ensure) {
      finishKey(entry, { status: 'unavailable' })
    }
  }
}
function selectCreator(task: KeyTask): boolean {
  for (const entry of keyEntries) {
    if (!entry.current?.()) {
      finishKey(entry, { status: 'retired' })
    } else if (entry.ensure) {
      task.authority = entry.authority = { current: entry.current }
      return true
    }
  }
  return false
}
async function createRouteKey(
  authority: Authority
): Promise<KeyObservation | { status: 'retired' }> {
  const fresh = await observeRouteKey()
  if (fresh.status !== 'missing') {
    return fresh
  }
  if (!authority.current?.()) {
    return { status: 'retired' }
  }
  try {
    const candidate = nacl.sign.keyPair.fromSeed(ExpoCrypto.getRandomBytes(32))
    const written = await writePairingKeychainItemIfCurrent(
      KEY,
      encodeBase64Bytes(candidate.secretKey),
      () => authority.current?.() === true
    )
    if (written === 'retired') {
      return { status: 'retired' }
    }
    committedKey = candidate
    return { status: 'present', keypair: candidate }
  } catch {
    return { status: 'unavailable' }
  }
}
async function runKeyTask(task: KeyTask): Promise<void> {
  completeKeyCohort(await observeRouteKey())
  while (selectCreator(task) && task.authority) {
    // The writer receives this exact permanently retireable cell, never a successor's slot.
    const fresh = await createRouteKey(task.authority)
    if (fresh.status !== 'retired') {
      completeKeyCohort(fresh)
      break
    }
    task.authority.current = undefined
    task.authority = undefined
  }
  if (task.authority) {
    task.authority.current = undefined
  }
  if (keyTask === task) {
    keyTask = undefined
  }
}
export function prepareKey(ensure: boolean, current: () => boolean) {
  if (committedKey) {
    const result: KeyResult = current()
      ? { status: 'ready', keypair: committedKey }
      : { status: 'retired' }
    return { result: Promise.resolve(result), release() {} }
  }
  const deferred = Promise.withResolvers<KeyResult>()
  const entry: KeyEntry = { ensure, current, resolve: deferred.resolve }
  keyEntries.add(entry)
  if (!current()) {
    finishKey(entry, { status: 'retired' })
  } else if (!keyTask) {
    keyTask = {}
    void runKeyTask(keyTask)
  }
  return {
    result: deferred.promise,
    release() {
      finishKey(entry, { status: 'retired' })
    }
  }
}
export function mobilePushRouteKey(isCurrent: () => boolean): RouteKeyPreparation {
  const interest = prepareKey(true, isCurrent)
  return {
    result: interest.result.then<Awaited<RouteKeyPreparation['result']>>((result) =>
      result.status === 'ready'
        ? { status: 'ready', routeKey: base64url(result.keypair.publicKey) }
        : result
    ),
    release: interest.release
  }
}
export function routeKeyPreparationSnapshotForTests() {
  return {
    keyEntries: keyEntries.size,
    keyCallables: [...keyEntries].filter((entry) => entry.current !== undefined).length,
    keyTask: Number(keyTask !== undefined),
    creatorCells: Number(keyTask?.authority !== undefined),
    creator: Number(keyTask?.authority?.current !== undefined)
  }
}
