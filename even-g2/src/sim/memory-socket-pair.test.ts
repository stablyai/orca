import { describe, expect, it } from 'vitest'
import { createMemorySocketPair, MEMORY_SOCKET_READY_STATE } from './memory-socket-pair'

function waitMicrotasks(n = 1): Promise<void> {
  let p = Promise.resolve()
  for (let i = 0; i < n; i++) {
    p = p.then(() => undefined)
  }
  return p
}

describe('createMemorySocketPair', () => {
  it('opens both ends asynchronously', async () => {
    const { clientSocket, serverSocket } = createMemorySocketPair()
    expect(clientSocket.readyState).toBe(MEMORY_SOCKET_READY_STATE.CONNECTING)
    expect(serverSocket.readyState).toBe(MEMORY_SOCKET_READY_STATE.CONNECTING)

    let clientOpened = false
    let serverOpened = false
    clientSocket.onopen = () => (clientOpened = true)
    serverSocket.onopen = () => (serverOpened = true)

    await waitMicrotasks(2)
    expect(clientOpened).toBe(true)
    expect(serverOpened).toBe(true)
    expect(clientSocket.readyState).toBe(MEMORY_SOCKET_READY_STATE.OPEN)
    expect(serverSocket.readyState).toBe(MEMORY_SOCKET_READY_STATE.OPEN)
  })

  it('delivers string frames client -> server and server -> client', async () => {
    const { clientSocket, serverSocket } = createMemorySocketPair()
    await waitMicrotasks(2)

    const serverReceived: string[] = []
    serverSocket.onmessage = (event) => serverReceived.push(event.data as string)
    clientSocket.send('hello from client')
    await waitMicrotasks(2)
    expect(serverReceived).toEqual(['hello from client'])

    const clientReceived: string[] = []
    clientSocket.onmessage = (event) => clientReceived.push(event.data as string)
    serverSocket.send('hello from server')
    await waitMicrotasks(2)
    expect(clientReceived).toEqual(['hello from server'])
  })

  it('delivers binary frames (ArrayBuffer and Uint8Array) as ArrayBuffer', async () => {
    const { clientSocket, serverSocket } = createMemorySocketPair()
    await waitMicrotasks(2)

    const received: ArrayBuffer[] = []
    serverSocket.onmessage = (event) => received.push(event.data as ArrayBuffer)

    const bytes = new Uint8Array([1, 2, 3, 4])
    clientSocket.send(bytes)
    clientSocket.send(bytes.buffer)
    await waitMicrotasks(2)

    expect(received).toHaveLength(2)
    expect(new Uint8Array(received[0]!)).toEqual(bytes)
    expect(new Uint8Array(received[1]!)).toEqual(bytes)
  })

  it('close() delivers already-sent messages before flipping readyState, then fires onclose on both ends', async () => {
    const { clientSocket, serverSocket } = createMemorySocketPair()
    await waitMicrotasks(2)

    const serverReceived: string[] = []
    serverSocket.onmessage = (event) => serverReceived.push(event.data as string)
    let clientClosed = false
    let serverClosed = false
    clientSocket.onclose = () => (clientClosed = true)
    serverSocket.onclose = () => (serverClosed = true)

    clientSocket.send('last message')
    clientSocket.close(1000, 'done')

    await waitMicrotasks(3)
    expect(serverReceived).toEqual(['last message'])
    expect(clientClosed).toBe(true)
    expect(serverClosed).toBe(true)
    expect(clientSocket.readyState).toBe(MEMORY_SOCKET_READY_STATE.CLOSED)
    expect(serverSocket.readyState).toBe(MEMORY_SOCKET_READY_STATE.CLOSED)
  })

  it('throws when sending before open', () => {
    const { clientSocket } = createMemorySocketPair()
    expect(() => clientSocket.send('too early')).toThrow()
  })
})
