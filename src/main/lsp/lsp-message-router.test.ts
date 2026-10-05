import { describe, expect, it } from 'vitest'
import { LspMessageRouter, type JsonRpcMessage } from './lsp-message-router'

function setup() {
  const toServer: JsonRpcMessage[] = []
  const router = new LspMessageRouter(
    (m) => toServer.push(m),
    [{ uri: 'file:///repo', name: 'repo' }]
  )
  return { router, toServer }
}
const doc = (uri: string) => ({ textDocument: { uri, languageId: 'ruby', version: 1, text: '' } })

describe('LspMessageRouter', () => {
  it('rewrites client ids per port and maps responses back', () => {
    const { router, toServer } = setup()
    router.fromClient(1, { jsonrpc: '2.0', id: 7, method: 'textDocument/hover', params: {} })
    router.fromClient(2, { jsonrpc: '2.0', id: 7, method: 'textDocument/hover', params: {} })
    const [a, b] = toServer
    expect(a.id).not.toBe(b.id)
    expect(router.fromServer({ jsonrpc: '2.0', id: b.id, result: 'B' })).toEqual({
      portId: 2,
      message: { jsonrpc: '2.0', id: 7, result: 'B' }
    })
  })

  it('rejects requests outside the allowlist without reaching the server', () => {
    const { router, toServer } = setup()
    const reply = router.fromClient(1, {
      jsonrpc: '2.0',
      id: 1,
      method: 'workspace/executeCommand'
    })
    expect(reply?.error?.code).toBe(-32601)
    expect(toServer).toHaveLength(0)
  })

  it('drops notifications outside the allowlist', () => {
    const { router, toServer } = setup()
    router.fromClient(1, { jsonrpc: '2.0', method: 'workspace/didChangeConfiguration', params: {} })
    expect(toServer).toHaveLength(0)
  })

  it('answers server requests itself and drops server notifications', () => {
    const { router, toServer } = setup()
    expect(
      router.fromServer({
        jsonrpc: '2.0',
        id: 'c1',
        method: 'workspace/configuration',
        params: { items: [{}, {}] }
      })
    ).toBeNull()
    expect(toServer.at(-1)).toEqual({ jsonrpc: '2.0', id: 'c1', result: [null, null] })
    router.fromServer({ jsonrpc: '2.0', id: 'c2', method: 'workspace/workspaceFolders' })
    expect(toServer.at(-1)?.result).toEqual([{ uri: 'file:///repo', name: 'repo' }])
    router.fromServer({ jsonrpc: '2.0', id: 'c3', method: 'custom/unknown' })
    expect(toServer.at(-1)?.error?.code).toBe(-32601)
    expect(
      router.fromServer({ jsonrpc: '2.0', method: 'textDocument/publishDiagnostics', params: {} })
    ).toBeNull()
  })

  it("closes a detached port's documents and forgets its pending requests", () => {
    const { router, toServer } = setup()
    router.fromClient(1, {
      jsonrpc: '2.0',
      method: 'textDocument/didOpen',
      params: doc('file:///a.rb')
    })
    router.fromClient(1, { jsonrpc: '2.0', id: 3, method: 'textDocument/definition', params: {} })
    const pendingId = toServer.at(-1)?.id
    router.detachPort(1)
    expect(toServer.at(-1)).toEqual({
      jsonrpc: '2.0',
      method: 'textDocument/didClose',
      params: { textDocument: { uri: 'file:///a.rb' } }
    })
    expect(router.fromServer({ jsonrpc: '2.0', id: pendingId, result: null })).toBeNull()
  })

  it('resolves internal requests without routing them to a port', async () => {
    const { router, toServer } = setup()
    const pending = router.request('initialize', {})
    expect(
      router.fromServer({ jsonrpc: '2.0', id: toServer[0].id, result: { capabilities: {} } })
    ).toBeNull()
    await expect(pending).resolves.toEqual({ capabilities: {} })
  })

  it('two ports open the same URI: only first didOpen forwarded; detach handles ownership correctly', () => {
    const { router, toServer } = setup()
    router.fromClient(1, {
      jsonrpc: '2.0',
      method: 'textDocument/didOpen',
      params: doc('file:///shared.rb')
    })
    router.fromClient(2, {
      jsonrpc: '2.0',
      method: 'textDocument/didOpen',
      params: doc('file:///shared.rb')
    })
    const didOpenMessages = toServer.filter((m) => m.method === 'textDocument/didOpen')
    expect(didOpenMessages).toHaveLength(1)
    expect(didOpenMessages[0].params).toEqual(doc('file:///shared.rb'))
    toServer.length = 0
    router.detachPort(1)
    expect(toServer).toHaveLength(0)
    toServer.length = 0
    router.detachPort(2)
    expect(toServer).toHaveLength(1)
    expect(toServer[0]).toEqual({
      jsonrpc: '2.0',
      method: 'textDocument/didClose',
      params: { textDocument: { uri: 'file:///shared.rb' } }
    })
  })

  it('didChange and didClose only from owner port are forwarded', () => {
    const { router, toServer } = setup()
    router.fromClient(1, {
      jsonrpc: '2.0',
      method: 'textDocument/didOpen',
      params: doc('file:///doc.rb')
    })
    toServer.length = 0
    router.fromClient(1, {
      jsonrpc: '2.0',
      method: 'textDocument/didChange',
      params: doc('file:///doc.rb')
    })
    expect(toServer).toHaveLength(1)
    expect(toServer[0].method).toBe('textDocument/didChange')
    toServer.length = 0
    router.fromClient(2, {
      jsonrpc: '2.0',
      method: 'textDocument/didChange',
      params: doc('file:///doc.rb')
    })
    expect(toServer).toHaveLength(0)
    toServer.length = 0
    router.fromClient(2, {
      jsonrpc: '2.0',
      method: 'textDocument/didClose',
      params: doc('file:///doc.rb')
    })
    expect(toServer).toHaveLength(0)
    router.fromClient(1, {
      jsonrpc: '2.0',
      method: 'textDocument/didClose',
      params: doc('file:///doc.rb')
    })
    expect(toServer).toHaveLength(1)
    expect(toServer[0].method).toBe('textDocument/didClose')
  })

  it('didOpen, didChange, didClose without valid uri are dropped', () => {
    const { router, toServer } = setup()
    router.fromClient(1, { jsonrpc: '2.0', method: 'textDocument/didOpen', params: {} })
    router.fromClient(1, {
      jsonrpc: '2.0',
      method: 'textDocument/didChange',
      params: { textDocument: {} }
    })
    router.fromClient(1, {
      jsonrpc: '2.0',
      method: 'textDocument/didClose',
      params: { textDocument: { uri: 123 } }
    })
    expect(toServer).toHaveLength(0)
  })

  it('allows workspace/symbol requests', () => {
    const { router, toServer } = setup()
    expect(
      router.fromClient(1, {
        jsonrpc: '2.0',
        id: 1,
        method: 'workspace/symbol',
        params: { query: 'Greeter' }
      })
    ).toBeNull()
    expect(toServer).toHaveLength(1)
  })

  it('allows semantic token requests', () => {
    const { router, toServer } = setup()
    expect(
      router.fromClient(1, {
        jsonrpc: '2.0',
        id: 1,
        method: 'textDocument/semanticTokens/full',
        params: { textDocument: { uri: 'file:///a.rb' } }
      })
    ).toBeNull()
    expect(toServer).toHaveLength(1)
  })

  it('answers the semantic tokens legend locally from the server capabilities', () => {
    const { router, toServer } = setup()
    const legendRequest = { jsonrpc: '2.0' as const, id: 4, method: 'orca/semanticTokensLegend' }
    expect(router.fromClient(1, legendRequest)).toEqual({ jsonrpc: '2.0', id: 4, result: null })
    const legend = { tokenTypes: ['variable', 'method'], tokenModifiers: ['declaration'] }
    router.setServerCapabilities({ capabilities: { semanticTokensProvider: { legend } } })
    expect(router.fromClient(1, legendRequest)).toEqual({ jsonrpc: '2.0', id: 4, result: legend })
    router.setServerCapabilities({ capabilities: { semanticTokensProvider: { legend: 'bad' } } })
    expect(router.fromClient(1, legendRequest)).toEqual({ jsonrpc: '2.0', id: 4, result: null })
    expect(toServer).toHaveLength(0)
  })
})
