import { createServer } from 'node:http'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'
import { createAcpAgentConnection } from '../acp/process/acp-agent-connection'
import { loadWindowsSecurity } from '../../shared/secure-storage/windows-security-addon'
import { restrictWindowsPathSync } from '../../shared/secure-storage/secure-path-windows-acl'

it('lists enabled desktop models and preserves only the chat selection after reattaching', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orca-qwenwork-models-'))
  const control = join(root, 'cli-control')
  const instanceId = '1'.repeat(32)
  const ticket = '2'.repeat(64)
  const sessionId = 'test-chat'
  let sessionModel: string | undefined
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
        data = { session_id: sessionId }
        break
      case 'session.get':
        data = { session: { session_id: sessionId } }
        break
      case 'model.list':
        data = { models: catalog }
        break
      case 'model.set':
        if (params.scope !== 'session' || params.session_id !== sessionId) {
          response.writeHead(400, { 'x-qwenwork-instance': instanceId }).end('{}')
          return
        }
        sessionModel = params.model
        break
      case 'model.get':
        data = {
          scope: params.scope,
          session_id: params.scope === 'session' ? sessionId : null,
          model: params.scope === 'session' ? sessionModel : 'automatic'
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
    await original.start({ cwd: root, mcpServers: [] })
    await expect(original.setConfigOption('model', 'disabled')).rejects.toThrow(/unavailable/i)
    expect((await original.setConfigOption('model', 'second')).configOptions[0]).toMatchObject({
      id: 'model',
      currentValue: 'second'
    })
    await original.close()
    const reattached = await connect().start({
      cwd: root,
      mcpServers: [],
      sessionId
    })
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
