import AsyncStorage from '@react-native-async-storage/async-storage'
import nacl from 'tweetnacl'
import { PUSH_LIMITS } from '../../../cloud/packages/push-contract/src/push-limits'
import {
  PushRouteAcceptedSchema,
  PushRouteCurrentSchema
} from '../../../cloud/packages/push-contract/src/route-declaration'
import {
  pushRouteDeclarationContent,
  type PushRouteContent
} from '../../../cloud/packages/push-contract/src/route-declaration-content'
import { encodeBase64Bytes } from '../transport/base64-byte-codec'
import { hostListMutationsSettled } from '../transport/host-list-mutation-queue'
import { readRouteCatalog, routeCatalogIdentity } from './push-route-catalog'
import { prepareKey } from './push-route-key-preparation'
import { postPushRoute, type RouteHttpResult } from './push-route-http'
import type { MobilePushToken } from './push-token'

export type RouteResult =
  | { status: 'accepted'; version: number; limited: boolean }
  | {
      status: 'refused'
      reason: 'capacity' | 'unsupported' | 'no-live-registration' | 'invalid-contract' | 'conflict'
    }
  | { status: 'unavailable' | 'retired' }
export type RouteCell = {
  pendingWake?: boolean
  current?: () => boolean
  token?: MobilePushToken
  resolve?: (result: RouteResult) => void
  key?: ReturnType<typeof prepareKey>
  keypair?: nacl.SignKeyPair
  catalog?: Set<string>
  body?: string
  floor?: number
  version?: number
  limited?: boolean
  http?: AbortController
  timer?: ReturnType<typeof setTimeout>
  resume?: () => void
}
export const ROUTE_VERSION = 'orca:push-route-version'
export function currentRoute(cell: RouteCell): boolean {
  return cell.current?.() === true && (!cell.catalog || cell.catalog === routeCatalogIdentity())
}
export function routeDelay(cell: RouteCell, ms: number): Promise<void> {
  return new Promise((resolve) => {
    cell.resume = resolve
    cell.timer = setTimeout(() => {
      cell.timer = undefined
      cell.resume = undefined
      resolve()
    }, ms)
  })
}
function base64url(bytes: Uint8Array): string {
  return encodeBase64Bytes(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
function sign(
  cell: RouteCell,
  operation:
    | { action: 'read' }
    | { action: 'replace'; version: number; expectedVersion: number | null; hosts: string[] }
): void {
  if (!cell.token || !cell.keypair) {
    return
  }
  const value: PushRouteContent = {
    v: 1,
    ...cell.token,
    routeKey: base64url(cell.keypair.publicKey),
    ...operation
  }
  cell.body = JSON.stringify({
    ...value,
    signature: base64url(
      nacl.sign.detached(
        new TextEncoder().encode(pushRouteDeclarationContent(value)),
        cell.keypair.secretKey
      )
    )
  })
  if (new TextEncoder().encode(cell.body).length > PUSH_LIMITS.maxHttpBodyBytes) {
    throw new Error('Route body exceeds protocol bound')
  }
}
async function send(cell: RouteCell): Promise<RouteHttpResult> {
  let attempt = 0
  cell.pendingWake = false
  while (currentRoute(cell) && cell.body) {
    cell.http = new AbortController()
    const response = await postPushRoute(cell.body, cell.http.signal)
    cell.http = undefined
    if (!currentRoute(cell)) {
      return { status: 0 }
    }
    if (response.status !== 0 && response.status !== 429 && response.status < 500) {
      return response
    }
    await routeDelay(cell, Math.min(60_000, 1000 * 2 ** Math.min(attempt++, 6)))
  }
  return { status: 0 }
}
function refusal(reply: RouteHttpResult): RouteResult {
  return {
    status: 'refused',
    reason:
      reply.status === 404
        ? 'unsupported'
        : reply.status === 403
          ? 'no-live-registration'
          : 'invalid-contract'
  }
}
function prepareTarget(cell: RouteCell, reply: RouteHttpResult): RouteResult | undefined {
  const read = PushRouteCurrentSchema.safeParse(reply.data)
  if (reply.status !== 200 || reply.invalid || !read.success || !cell.catalog) {
    return refusal(reply)
  }
  const retained = read.data.hosts.filter((host) => cell.catalog?.has(host))
  cell.limited = cell.catalog.size > PUSH_LIMITS.maxRouteHosts
  if (cell.limited && retained.length === read.data.hosts.length) {
    // Absence and an already-empty row are not pruning receipts.
    if (read.data.version === null || retained.length === 0) {
      return { status: 'refused', reason: 'capacity' }
    }
  }
  const hosts = cell.limited ? retained : [...cell.catalog]
  const observed = read.data.version ?? 0
  cell.version = Math.max(Date.now(), (cell.floor ?? 0) + 1, observed + 1)
  if (!Number.isSafeInteger(cell.version) || cell.version <= 0) {
    return { status: 'unavailable' }
  }
  sign(cell, {
    action: 'replace',
    version: cell.version,
    expectedVersion: read.data.version,
    hosts: hosts.sort()
  })
}
function takeKey(
  cell: RouteCell,
  result: Awaited<ReturnType<typeof prepareKey>['result']>
): boolean {
  if (!currentRoute(cell) || result.status !== 'ready') {
    return false
  }
  cell.keypair = result.keypair
  return true
}
function takeCatalog(cell: RouteCell, catalog: Set<string>): void {
  if (cell.current?.()) {
    cell.catalog = catalog
  }
}
async function attempt(cell: RouteCell): Promise<RouteResult> {
  cell.pendingWake = false
  const floor = await AsyncStorage.getItem(ROUTE_VERSION)
  if (!currentRoute(cell)) {
    return { status: 'retired' }
  }
  cell.floor = Number(floor ?? 0)
  if (
    !Number.isSafeInteger(cell.floor) ||
    cell.floor < 0 ||
    cell.floor === Number.MAX_SAFE_INTEGER ||
    (floor !== null && !/^[1-9]\d*$/.test(floor))
  ) {
    return { status: 'unavailable' }
  }
  await hostListMutationsSettled()
  if (!currentRoute(cell)) {
    return { status: 'retired' }
  }
  takeCatalog(cell, await readRouteCatalog())
  for (let conflict = 0; conflict < 3 && currentRoute(cell); conflict++) {
    sign(cell, { action: 'read' })
    const result = prepareTarget(cell, await send(cell))
    if (!currentRoute(cell)) {
      break
    }
    if (result) {
      return result
    }
    if (cell.version === undefined) {
      return { status: 'unavailable' }
    }
    await AsyncStorage.setItem(ROUTE_VERSION, String(cell.version))
    if (!currentRoute(cell)) {
      break
    }
    cell.floor = cell.version
    const reply = await send(cell)
    if (!currentRoute(cell)) {
      break
    }
    if (reply.status === 409 && !reply.invalid) {
      continue
    }
    const accepted = PushRouteAcceptedSchema.safeParse(reply.data)
    return reply.status === 200 &&
      !reply.invalid &&
      accepted.success &&
      accepted.data.version === cell.version
      ? { status: 'accepted', version: accepted.data.version, limited: cell.limited === true }
      : refusal(reply)
  }
  return currentRoute(cell) ? { status: 'refused', reason: 'conflict' } : { status: 'retired' }
}
export async function reconcileRoute(cell: RouteCell): Promise<RouteResult> {
  cell.key = prepareKey(false, () => cell.current?.() === true)
  if (!takeKey(cell, await cell.key.result)) {
    return { status: 'unavailable' }
  }
  cell.key.release()
  cell.key = undefined
  for (let source = 0; source < 3 && currentRoute(cell); source++) {
    try {
      return await attempt(cell)
    } catch {
      if (!currentRoute(cell)) {
        break
      }
      cell.catalog = undefined
      if (source === 2) {
        return { status: 'unavailable' }
      }
      await routeDelay(cell, 5000)
    }
  }
  return { status: 'retired' }
}
