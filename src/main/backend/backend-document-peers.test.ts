import { MessageChannel, type MessagePort } from 'node:worker_threads'
import { afterEach, expect, it, vi } from 'vitest'
import { BackendPortRpc, type BackendPort } from '../../shared/backend/backend-port-rpc'
import { BackendDocumentPeers } from './backend-document-peers'

const ports: MessagePort[] = []
function adapt(port: MessagePort): BackendPort {
  ports.push(port)
  return {
    postMessage: (message) => port.postMessage(message),
    onMessage(listener) {
      port.on('message', listener)
      return () => port.off('message', listener)
    },
    onClose(listener) {
      port.on('close', listener)
      return () => port.off('close', listener)
    },
    close: () => port.close()
  }
}
afterEach(() => {
  ports.splice(0).forEach((port) => port.close())
})

it('serves a document only public usage operations, bound to the identity main minted', async () => {
  const serve = vi.fn(async () => 'served')
  const peers = new BackendDocumentPeers('backend-1', serve)
  const channel = new MessageChannel()
  const document = { id: '0d6c4a40-8a0f-4e8f-9f43-2d0b3c4c9a11', role: 'popout' }
  expect(
    peers.admit({ type: 'client', incarnation: 'backend-1', document }, adapt(channel.port1))
  ).toBe(true)
  const renderer = new BackendPortRpc(
    adapt(channel.port2),
    'renderer',
    async () => null,
    undefined,
    'backend-1'
  )
  await expect(renderer.call('backend.stop')).rejects.toThrow('not available to Orca windows')
  await expect(renderer.call('claudeUsage:getAutomationRunUsage', {})).rejects.toThrow(
    'not available to Orca windows'
  )
  await expect(renderer.call('claudeUsage:getScanState')).resolves.toBe('served')
  expect(serve).toHaveBeenCalledTimes(1)
  expect(serve).toHaveBeenCalledWith(
    { ...document, incarnation: 'backend-1' },
    'claudeUsage:getScanState',
    undefined,
    expect.any(AbortSignal)
  )
  renderer.close()
  peers.closeAll()
})

it('refuses a port minted for another backend incarnation', () => {
  const peers = new BackendDocumentPeers('backend-2', async () => null)
  const channel = new MessageChannel()
  const closed = vi.fn()
  const port = { ...adapt(channel.port1), close: closed }
  expect(
    peers.admit(
      {
        type: 'client',
        incarnation: 'backend-1',
        document: { id: '0d6c4a40-8a0f-4e8f-9f43-2d0b3c4c9a11', role: 'main' }
      },
      port
    )
  ).toBe(false)
  expect(closed).toHaveBeenCalledTimes(1)
})
