import { expect } from 'vitest'
import WebSocket from 'ws'
import { parsePairingCode } from '../../shared/pairing'
import { decrypt, deriveSharedKey, encrypt, generateKeyPair } from './rpc/e2ee-crypto'

export function connectWs(endpoint: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(endpoint)
    ws.once('open', () => resolve(ws))
    ws.once('error', reject)
  })
}

export function nextWsMessage(ws: WebSocket): Promise<string> {
  return new Promise((resolve) => {
    ws.once('message', (data) => {
      resolve(typeof data === 'string' ? data : data.toString('utf-8'))
    })
  })
}

export function waitForWsClose(ws: WebSocket): Promise<void> {
  return new Promise((resolve) => {
    if (ws.readyState === ws.CLOSED) {
      resolve()
      return
    }
    ws.once('close', () => resolve())
  })
}

export type AuthenticatedMobileWs = {
  ws: WebSocket
  sharedKey: Uint8Array
}

export async function authenticateMobileWsSession(
  pairingUrl: string
): Promise<AuthenticatedMobileWs> {
  const parsed = parsePairingCode(pairingUrl)
  expect(parsed).toBeTruthy()
  const ws = await connectWs(parsed!.endpoint)
  const mobileKeys = generateKeyPair()
  const serverPublicKey = Uint8Array.from(Buffer.from(parsed!.publicKeyB64, 'base64'))
  const sharedKey = deriveSharedKey(mobileKeys.secretKey, serverPublicKey)

  ws.send(
    JSON.stringify({
      type: 'e2ee_hello',
      publicKeyB64: Buffer.from(mobileKeys.publicKey).toString('base64')
    })
  )
  expect(JSON.parse(await nextWsMessage(ws))).toEqual({ type: 'e2ee_ready' })

  ws.send(
    encrypt(JSON.stringify({ type: 'e2ee_auth', deviceToken: parsed!.deviceToken }), sharedKey)
  )
  expect(JSON.parse(decrypt(await nextWsMessage(ws), sharedKey)!)).toEqual({
    type: 'e2ee_authenticated'
  })

  return { ws, sharedKey }
}

export async function authenticateMobileWs(pairingUrl: string): Promise<WebSocket> {
  return (await authenticateMobileWsSession(pairingUrl)).ws
}

export function sendEncryptedWsRequest(
  session: AuthenticatedMobileWs,
  request: Record<string, unknown>
): void {
  session.ws.send(encrypt(JSON.stringify(request), session.sharedKey))
}

export function createEncryptedWsResponseReader(session: AuthenticatedMobileWs): {
  next: (
    id: string,
    predicate?: (response: Record<string, unknown>) => boolean
  ) => Promise<Record<string, unknown>>
  dispose: () => void
} {
  type Waiter = {
    id: string
    predicate: (response: Record<string, unknown>) => boolean
    resolve: (response: Record<string, unknown>) => void
  }
  const queue: Record<string, unknown>[] = []
  const waiters: Waiter[] = []

  const takeQueued = (
    id: string,
    predicate: (response: Record<string, unknown>) => boolean
  ): Record<string, unknown> | null => {
    const index = queue.findIndex((response) => response.id === id && predicate(response))
    if (index === -1) {
      return null
    }
    const [response] = queue.splice(index, 1)
    return response ?? null
  }

  const onMessage = (data: WebSocket.RawData): void => {
    const decrypted = decrypt(
      typeof data === 'string' ? data : data.toString('utf-8'),
      session.sharedKey
    )
    expect(decrypted).toBeTruthy()
    const response = JSON.parse(decrypted!) as Record<string, unknown>
    const waiterIndex = waiters.findIndex(
      (waiter) => response.id === waiter.id && waiter.predicate(response)
    )
    if (waiterIndex === -1) {
      queue.push(response)
      return
    }
    const [waiter] = waiters.splice(waiterIndex, 1)
    waiter?.resolve(response)
  }

  session.ws.on('message', onMessage)

  return {
    next: (id: string, predicate: (response: Record<string, unknown>) => boolean = () => true) => {
      const queued = takeQueued(id, predicate)
      if (queued) {
        return Promise.resolve(queued)
      }
      return new Promise<Record<string, unknown>>((resolve) => {
        waiters.push({ id, predicate, resolve })
      })
    },
    dispose: () => {
      session.ws.off('message', onMessage)
      waiters.length = 0
      queue.length = 0
    }
  }
}
