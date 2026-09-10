import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import {
  createRpcAccessResolver,
  unsubscribeFrameMethod
} from '../../scripts/rpc-access-resolution.mts'

function fixture(source: string) {
  const file = 'rpc-fixture.ts'
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
  const host = ts.createCompilerHost({ noLib: true, types: [] })
  host.getSourceFile = (name) => (name === file ? sourceFile : undefined)
  const program = ts.createProgram([file], { noLib: true, types: [] }, host)
  return createRpcAccessResolver(program, [file])
}

describe('RPC access symbol resolution', () => {
  it('follows aliases, destructuring, bracket constants and bound senders', () => {
    const resolver = fixture(`
      declare const client: { sendRequest(method: string): void; subscribe(method: string): void }
      const direct = client.sendRequest
      const alias = direct
      const { sendRequest: destructured } = client
      const bound = client.sendRequest.bind(client)
      const key = 'sendRequest'
      alias('git.status'); destructured('files.list'); bound('settings.get'); client[key]('repo.list')
      const { subscribe: stream } = client
      stream('terminal.subscribe')
    `)
    const recognized = resolver.calls.filter((call) => resolver.resolveKind(call.expression))
    expect(recognized.map((call) => resolver.methods(call.arguments[0]))).toEqual([
      ['git.status'],
      ['files.list'],
      ['settings.get'],
      ['repo.list'],
      ['terminal.subscribe']
    ])
  })
  it('fails closed when one caller supplies an unresolved method', () => {
    const resolver = fixture(`
      declare const client: { sendRequest(method: string): void }
      declare const unknownMethod: string
      function forward(method: string) { client.sendRequest(method) }
      forward('git.status'); forward(unknownMethod)
    `)
    const raw = resolver.calls.find((call) => resolver.resolveKind(call.expression) === 'request')!
    expect(resolver.methods(raw.arguments[0])).toEqual([])
  })
  it('derives the complete literal family from forwarder callers', () => {
    const resolver = fixture(`
      declare const client: { sendRequest(method: string): void }
      function forward(method: string) { client.sendRequest(method) }
      forward('git.status'); forward('git.fetch')
    `)
    const raw = resolver.calls.find((call) => resolver.resolveKind(call.expression) === 'request')!
    expect(resolver.methods(raw.arguments[0])).toEqual(['git.fetch', 'git.status'])
  })
  it('includes callers reached only through a function-type alias', () => {
    const resolver = fixture(`
      declare const client: { sendRequest(method: string): void }
      type RunHook = (method: string) => void
      const send = (method: string) => { client.sendRequest(method) }
      send('resolved.direct')
      const run: RunHook = send
      run('hidden.viaTypeAlias')
    `)
    const raw = resolver.calls.find((call) => resolver.resolveKind(call.expression) === 'request')!
    expect(resolver.methods(raw.arguments[0])).toEqual(['hidden.viaTypeAlias', 'resolved.direct'])
  })
  it('fails closed for a property handed to another function', () => {
    const resolver = fixture(`
      declare const client: { sendRequest(method: string): void }
      type RunHook = (method: string) => void
      declare function useThing(args: { run: RunHook }): void
      const send = (method: string) => { client.sendRequest(method) }
      send('resolved.direct')
      useThing({ run: send })
      declare const args: { run: RunHook }
      args.run('hidden.viaShorthand')
    `)
    const raw = resolver.calls.find((call) => resolver.resolveKind(call.expression) === 'request')!
    expect(resolver.methods(raw.arguments[0])).toEqual([])
  })
  it('does not hide an unresolved caller behind an object binding', () => {
    const resolver = fixture(`
      declare const client: { sendRequest(method: string): void }
      declare const unknownMethod: string
      function forward(args: { method: string }) { const { method } = args; client.sendRequest(method) }
      forward({ method: 'git.status' }); forward({ method: unknownMethod })
    `)
    const raw = resolver.calls.find((call) => resolver.resolveKind(call.expression) === 'request')!
    expect(resolver.methods(raw.arguments[0])).toEqual([])
  })
  it.each([
    'return { send }',
    'consume(send); return { send }',
    'target.send = send; return target',
    'const alias = send; return { send: alias }'
  ])('fails closed across a destructured hook result: %s', (escape) => {
    const resolver = fixture(`
      declare const client: { sendRequest(method: string): void }
      declare function consume(send: (method: string) => void): void
      declare const target: { send: (method: string) => void }
      function useFoo() {
        const send = (method: string) => { client.sendRequest(method) }
        send('git.status')
        ${escape}
      }
      const { send: x } = useFoo()
      x('git.checkout')
    `)
    const raw = resolver.calls.find((call) => resolver.resolveKind(call.expression) === 'request')!
    expect(resolver.methods(raw.arguments[0])).toEqual([])
  })
  it('fails closed when an alias call is absent from the enumerated signatures', () => {
    const resolver = fixture(`
      declare const client: { sendRequest(method: string): void }
      type RunHook = (method: string) => void
      const send = (method: string) => { client.sendRequest(method) }
      send('git.status')
      const alias = send
      const run: RunHook = alias
      run('git.checkout')
    `)
    const raw = resolver.calls.find((call) => resolver.resolveKind(call.expression) === 'request')!
    expect(resolver.methods(raw.arguments[0])).toEqual([])
  })
  it('records unsubscribe frame methods separately from requests and subscriptions', () => {
    const source = ts.createSourceFile(
      'frames.ts',
      `
      const frames = [
        { method: 'terminal.unsubscribe' },
        { method: 'session.tabs.unsubscribe' },
        { method: 'nativeChat.unsubscribe' },
        { method: 'browser.screencast.unsubscribe' },
        { method: 'runtime.clientEvents.unsubscribe' },
        { method: 'terminal.subscribe' },
        { label: 'ignored.unsubscribe' }
      ]
      const dead = new Set(['github.prComments', 'ignored.unsubscribe'])
    `,
      ts.ScriptTarget.Latest,
      true
    )
    const methods: string[] = []
    function visit(node: ts.Node): void {
      const method = unsubscribeFrameMethod(node)
      if (method) {
        methods.push(method)
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
    expect(methods).toEqual([
      'terminal.unsubscribe',
      'session.tabs.unsubscribe',
      'nativeChat.unsubscribe',
      'browser.screencast.unsubscribe',
      'runtime.clientEvents.unsubscribe'
    ])
    const resolver = fixture(`
      declare const streams: { sendUnsubscribe(frame: unknown): void }
      streams.sendUnsubscribe({ method: unknownMethod })
    `)
    expect(resolver.calls.map((call) => resolver.resolveKind(call.expression))).toEqual([
      'unsubscribe'
    ])
  })
})
