import { randomUUID } from 'node:crypto'
import { readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import {
  PI_DRAFT_BRIDGE_PROTOCOL,
  PiDraftBridgeHelloSchema,
  PiDraftBridgeResponseSchema,
  type PiDraftBridgeHello,
  type PiDraftBridgeRequest,
  type PiDraftBridgeResponse
} from './draft-bridge-protocol'
import { isProcessAlive, type PiDraftBridgePaths } from './draft-bridge-directory'

const RESPONSE_POLL_MS = 15
const HELLO_MAX_AGE_MS = 6000

export type PiDraftBridgeCapability =
  | { supported: true; hello: PiDraftBridgeHello; processIncarnation: string }
  | { supported: false; reason: 'no_bridge' | 'stale_bridge' | 'unsupported_agent' }

export async function readPiDraftBridgeCapability(
  paths: PiDraftBridgePaths,
  now = Date.now()
): Promise<PiDraftBridgeCapability> {
  let hello: PiDraftBridgeHello
  try {
    const parsed = PiDraftBridgeHelloSchema.safeParse(
      JSON.parse(await readFile(join(paths.dir, 'hello.json'), 'utf8'))
    )
    if (!parsed.success) {
      return { supported: false, reason: 'no_bridge' }
    }
    hello = parsed.data
  } catch {
    return { supported: false, reason: 'no_bridge' }
  }
  if (hello.protocol !== PI_DRAFT_BRIDGE_PROTOCOL || hello.token !== paths.session.token) {
    return { supported: false, reason: 'no_bridge' }
  }
  if (!isProcessAlive(hello.pid) || now - hello.at > HELLO_MAX_AGE_MS) {
    return { supported: false, reason: 'stale_bridge' }
  }
  if (hello.capabilities.capture !== true || hello.capabilities.replace !== true) {
    return { supported: false, reason: 'unsupported_agent' }
  }
  return {
    supported: true,
    hello,
    processIncarnation: `${hello.pid}:${hello.startedAt}:${hello.instanceId.slice(0, 12)}`
  }
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const tmp = `${path}.${process.pid}.tmp`
  await writeFile(tmp, JSON.stringify(value))
  try {
    await rename(tmp, path)
  } catch {
    await writeFile(path, JSON.stringify(value))
    await rm(tmp, { force: true })
  }
}

/** One bridge directory answers one request at a time, so a late capture cannot overwrite a save. */
const bridgeQueues = new Map<string, Promise<unknown>>()

async function runExclusive<T>(dir: string, task: () => Promise<T>): Promise<T> {
  const previous = bridgeQueues.get(dir) ?? Promise.resolve()
  const next = previous.then(task, task)
  const guarded = next.catch(() => {})
  bridgeQueues.set(dir, guarded)
  try {
    return await next
  } finally {
    if (bridgeQueues.get(dir) === guarded) {
      bridgeQueues.delete(dir)
    }
  }
}

async function requestOnce(
  paths: PiDraftBridgePaths,
  request: Omit<PiDraftBridgeRequest, 'protocol' | 'token' | 'id'>,
  timeoutMs: number
): Promise<PiDraftBridgeResponse | null> {
  const id = randomUUID()
  const payload: PiDraftBridgeRequest = {
    protocol: PI_DRAFT_BRIDGE_PROTOCOL,
    token: paths.session.token,
    id,
    ...request
  }
  const responsePath = join(paths.dir, 'response.json')
  await rm(responsePath, { force: true })
  await writeJsonAtomic(join(paths.dir, 'request.json'), payload)
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const parsed = PiDraftBridgeResponseSchema.safeParse(
        JSON.parse(await readFile(responsePath, 'utf8'))
      )
      if (
        parsed.success &&
        parsed.data.protocol === PI_DRAFT_BRIDGE_PROTOCOL &&
        parsed.data.token === paths.session.token &&
        parsed.data.id === id
      ) {
        await rm(responsePath, { force: true })
        return parsed.data
      }
    } catch {}
    await delay(RESPONSE_POLL_MS)
  }
  return null
}

export function requestPiDraftCapture(
  paths: PiDraftBridgePaths,
  timeoutMs = 2000
): Promise<PiDraftBridgeResponse | null> {
  return runExclusive(paths.dir, () => requestOnce(paths, { op: 'capture' }, timeoutMs))
}

export function requestPiDraftReplace(
  paths: PiDraftBridgePaths,
  text: string,
  baseToken: string,
  timeoutMs = 2000
): Promise<PiDraftBridgeResponse | null> {
  return runExclusive(paths.dir, () =>
    requestOnce(paths, { op: 'replace', text, baseToken }, timeoutMs)
  )
}
