import { createServer } from 'node:http'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'
import { createAcpAgentConnection } from '../acp/process/acp-agent-connection'
import { loadWindowsSecurity } from '../../shared/secure-storage/windows-security-addon'
import { restrictWindowsPathSync } from '../../shared/secure-storage/secure-path-windows-acl'

it('recovers model selection and streams and stops replies in the same desktop conversation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orca-qwenwork-models-'))
  const control = join(root, 'cli-control')
  const instanceId = '1'.repeat(32)
  const ticket = '2'.repeat(64)
  const sessionId = 'test-chat'
  let sessionModel: string | undefined
  let catalogUnavailable = false
  let loseWriteResponse = true
  let stopping = false
  const waitingForResult = Promise.withResolvers<void>()
  const fragments: string[] = []
  const newModels: string[] = []
  const catalog = [
    { key: 'automatic', display_name: 'Automatic', enabled: true },
    { key: 'second', display_name: 'Second model', enabled: true },
    { key: 'disabled', display_name: 'Unavailable model', enabled: false }
  ]
  const desktop = createServer(async (request, response) => {
    if (request.headers.authorization !== `Bearer ${ticket}`) {
      response.writeHead(401).end()
      return
    }
    const chunks: Buffer[] = []
    for await (const chunk of request) {
      chunks.push(chunk)
    }
    const { method, params } = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    let data = {}
    switch (method) {
      case 'desktop.status':
        data = {
          protocol: 'qwenwork.desktop.v1',
          authenticated: true,
          user: { user_id: 'test-user' },
          features: { model_selection: true, task_execution: true, session_history: true }
        }
        break
      case 'session.create':
        sessionModel = 'automatic'
        catalogUnavailable = true
        data = { session_id: sessionId }
        break
      case 'session.get':
        data = { session: { session_id: sessionId } }
        break
      case 'model.list':
        if (catalogUnavailable) {
          catalogUnavailable = false
          response.writeHead(503, { 'x-qwenwork-instance': instanceId }).end()
          return
        }
        data = { models: catalog }
        break
      case 'model.set':
        if (params.scope !== 'session' || params.session_id !== sessionId) {
          response.writeHead(400, { 'x-qwenwork-instance': instanceId }).end('{}')
          return
        }
        if (params.model === 'automatic') {
          response.writeHead(503, { 'x-qwenwork-instance': instanceId }).end()
          return
        }
        sessionModel = params.model
        if (loseWriteResponse) {
          loseWriteResponse = false
          response.writeHead(503, { 'x-qwenwork-instance': instanceId }).end()
          return
        }
        data = { scope: 'session', session_id: sessionId, model: sessionModel }
        break
      case 'model.get':
        data = {
          scope: params.scope,
          session_id: params.scope === 'session' ? sessionId : null,
          model: params.scope === 'session' ? sessionModel : 'automatic'
        }
        break
      case 'task.submit':
        stopping = params.prompt === 'Stop this turn'
        data = {
          task_id: params.request_id,
          session_id: sessionId,
          terminal: stopping,
          status: stopping ? 'completed' : 'running',
          ...(stopping ? {} : { answer: 'Hello', answer_is_final: false })
        }
        break
      case 'task.get':
        data = {
          task_id: params.task_id,
          session_id: sessionId,
          terminal: fragments.includes('Hello'),
          status: fragments.includes('Hello') ? 'completed' : 'running',
          answer: 'Hello'
        }
        break
      case 'task.result':
        if (stopping) {
          waitingForResult.resolve()
          await new Promise<void>((closed) => response.once('close', closed))
          return
        }
        data = {
          task_id: params.task_id,
          session_id: sessionId,
          terminal: true,
          status: 'completed',
          answer: 'Hello world',
          answer_is_final: true
        }
        break
      default:
        response.writeHead(404).end()
        return
    }
    response.writeHead(200, { 'x-qwenwork-instance': instanceId }).end(
      JSON.stringify({
        schema_version: 'qwenwork.response.v1',
        ok: true,
        data: { backend: 'desktop', ...data }
      })
    )
  })
  const connections: ReturnType<typeof createAcpAgentConnection>[] = []
  try {
    await mkdir(control, { mode: 0o700 })
    let windowsModule: string[] = []
    if (process.platform === 'win32') {
      const security = loadWindowsSecurity()
      if ('error' in security || !security.modulePath || !restrictWindowsPathSync(control, true)) {
        throw new Error('Cannot initialize a private Windows desktop-control fixture')
      }
      windowsModule = [security.modulePath]
    }
    await mkdir(join(control, instanceId), { mode: 0o700 })
    await new Promise<void>((ready) => desktop.listen(0, '127.0.0.1', ready))
    const address = desktop.address()
    if (!address || typeof address === 'string') {
      throw new Error('Missing loopback fixture address')
    }
    await writeFile(
      join(control, 'endpoint.json'),
      JSON.stringify({
        protocol: 'qwenwork.desktop.v1',
        port: address.port,
        instance_id: instanceId
      }),
      { mode: 0o600 }
    )
    await writeFile(join(control, instanceId, 'token'), ticket, { mode: 0o600 })
    const connect = () => {
      const connection = createAcpAgentConnection({
        command: process.execPath,
        args: [resolve('resources/qwenwork/desktop-acp.cjs'), root, ...windowsModule],
        env: { ELECTRON_RUN_AS_NODE: '1' }
      })
      connections.push(connection)
      return connection
    }
    const original = connect()
    expect(await original.requestSessionFreeExtension('_qwenwork/models', {}, 5_000)).toEqual({
      models: [
        { id: 'automatic', label: 'Automatic', isDefault: true, efforts: [] },
        { id: 'second', label: 'Second model', isDefault: false, efforts: [] }
      ]
    })
    expect(sessionModel).toBeUndefined()
    original.subscribe((event) => {
      if (event.kind !== 'known') {
        return
      }
      const { update } = event.notification
      if (update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text') {
        fragments.push(update.content.text)
      }
      if (update.sessionUpdate === 'config_option_update') {
        newModels.push(
          ...update.configOptions.flatMap((option) =>
            option.id === 'model' && option.type === 'select' ? [option.currentValue] : []
          )
        )
      }
    })
    const started = await original.start({ cwd: root, mcpServers: [] })
    expect(started.sessionId).toBe(sessionId)
    expect(started.response.configOptions).toEqual([])
    await expect(original.setConfigOption('model', 'disabled')).rejects.toThrow(/unavailable/i)
    await expect(original.setConfigOption('model', 'second')).rejects.toThrow(
      /temporarily unavailable/i
    )
    await expect(original.setConfigOption('model', 'automatic')).rejects.toThrow(
      /temporarily unavailable/i
    )
    const send = (text: string) => original.prompt([{ type: 'text', text }])
    await expect(send('Check the recovered model')).rejects.toThrow(/check it and send again/i)
    expect(newModels.at(-1)).toBe('second')
    expect((await send('Reply in two pieces')).stopReason).toBe('end_turn')
    expect(fragments).toEqual(['Hello', ' world'])
    const stopped = send('Stop this turn')
    await waitingForResult.promise
    await original.cancel()
    expect((await stopped).stopReason).toBe('cancelled')
    expect(fragments).toEqual(['Hello', ' world'])
    await original.close()
    const reattached = await connect().start({
      cwd: root,
      mcpServers: [],
      sessionId
    })
    expect(reattached.kind).toBe('resume')
    expect(reattached.response.configOptions?.[0]).toMatchObject({
      id: 'model',
      currentValue: 'second'
    })
  } finally {
    await Promise.allSettled(connections.map((connection) => connection.close()))
    desktop.closeAllConnections()
    await new Promise<void>((done) => desktop.close(() => done()))
    await rm(root, { recursive: true, force: true })
  }
})
