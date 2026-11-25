import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { describe, expect, it } from 'vitest'
import { answerWithNoTools } from './mcp-no-tools-server'

describe('answerWithNoTools', () => {
  it('completes a real SDK client handshake and lists no tools', async () => {
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
    answerWithNoTools(serverSide, '9.9.9')
    await serverSide.start()
    const client = new Client({ name: 'probe', version: '1' })
    await client.connect(clientSide)

    expect(client.getServerVersion()).toEqual({ name: 'orca', version: '9.9.9' })
    expect(client.getServerCapabilities()).toEqual({ tools: {} })
    await expect(client.listTools()).resolves.toEqual({ tools: [] })
    await expect(client.ping()).resolves.toEqual({})
    await expect(client.listResources()).rejects.toThrow(/Method not found/)
    await client.close()
  })

  it('answers an unsupported protocol version with the latest one it speaks', async () => {
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
    answerWithNoTools(serverSide, '1')
    const answers: unknown[] = []
    clientSide.onmessage = (message) => answers.push(message)
    await Promise.all([serverSide.start(), clientSide.start()])
    await clientSide.send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '1999-01-01',
        capabilities: {},
        clientInfo: { name: 'p', version: '1' }
      }
    })
    expect(answers).toEqual([
      expect.objectContaining({
        id: 1,
        result: expect.objectContaining({ protocolVersion: '2025-11-25' })
      })
    ])
  })
})
