import { PassThrough } from 'node:stream'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { AcpSessionRuntime } from '../protocol/acp-session-runtime'
import type { FakeFrame } from '../process/testing/acp-scripted-agent.test-support'
import { FakeAcpChild } from '../process/testing/acp-scripted-connection.test-fixture'
import { startExternalAcpLauncher } from './external-acp-launcher.mjs'
import { validateExternalAcpProfile } from './external-acp-profile.mjs'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function profile(root: string) {
  return validateExternalAcpProfile({
    nativeCommand: join(root, 'native-server'),
    nativeHome: join(root, 'native-home'),
    modelIds: ['model-alpha', 'pi'],
    defaultModel: 'model-alpha-high',
    gatewayBaseUrl: 'https://gateway.example.test'
  })
}

function models(currentValue: string) {
  return [
    {
      id: 'model',
      name: 'Model',
      category: 'model',
      type: 'select',
      currentValue,
      options: [
        { value: 'model-alpha-high', name: 'Model Alpha High' },
        { value: 'pi', name: 'Pi' }
      ]
    }
  ]
}

it('forwards initialize, gateway auth, model selection, notifications, cancellation and shutdown', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orca-external-launcher-'))
  roots.push(root)
  let native: FakeAcpChild
  let interruptedFrame: FakeFrame | undefined
  const input = new PassThrough()
  const output = new PassThrough()
  const permission = vi.fn(() => ({
    outcome: { outcome: 'selected' as const, optionId: 'allow' }
  }))
  await startExternalAcpLauncher(profile(root), {
    input,
    output,
    tokenOverride: 'fixture-token',
    createConnection: (launch, connectionOptions) => {
      native = new FakeAcpChild(launch, connectionOptions)
      native.agent.on('initialize', (frame) => {
        native.agent.reply(frame, {
          protocolVersion: 1,
          agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {}, list: {} } },
          authMethods: [{ id: 'gateway', name: 'AI API Gateway' }]
        })
      })
      native.agent.on('authenticate', (frame) => native.agent.reply(frame, {}))
      native.agent.on('session/new', (frame) =>
        native!.agent.reply(frame, {
          sessionId: 'native-session',
          configOptions: models('model-alpha-high')
        })
      )
      native.agent.confirmConfigOptions(models('model-alpha-high'))
      native.agent.on('session/prompt', (frame) => {
        if (JSON.stringify(frame.params).includes('Interrupted prompt')) {
          interruptedFrame = frame
        } else {
          native!.agent.reply(frame, { stopReason: 'end_turn' })
        }
      })
      native.agent.on('session/cancel', () => {
        native!.agent.reply(interruptedFrame!, { stopReason: 'cancelled' })
      })
      return native
    }
  })
  const client = new AcpSessionRuntime(output, input, {
    clientInfo: { name: 'orca', version: '1' },
    onPermission: permission
  })
  const initialized = await client.initialize()
  expect(initialized.authMethods?.map((method) => method.id)).toContain('gateway')
  await client.start({ cwd: '/workspace', mcpServers: [] })
  const auth = native!.agent.frames.find((frame) => frame.method === 'authenticate')
  expect(auth?.params).toMatchObject({
    methodId: 'gateway',
    _meta: { gateway: { headers: { Authorization: 'Bearer fixture-token' } } }
  })
  expect(auth?.params).toHaveProperty(
    ['_meta', 'gateway', 'headers', 'x-orca-acp-loopback-auth'],
    expect.any(String)
  )
  expect(native!.launch.env).toMatchObject({
    AGY_LLM_GATEWAY_MODELS: 'model-alpha,pi',
    AGY_ACP_DEFAULT_MODEL: 'model-alpha-high'
  })
  const pi = await client.setConfigOption('model', 'pi')
  expect(pi.configOptions?.at(-1)?.currentValue).toBe('pi')
  const alpha = await client.setConfigOption('model', 'model-alpha-high')
  expect(alpha.configOptions?.at(-1)?.currentValue).toBe('model-alpha-high')
  expect(
    await readFile(join(root, 'native-home', 'antigravity-acp', 'settings.json'), 'utf8')
  ).toBe('{"auth":{"type":"gateway"}}')
  const requested = native!.agent.request(77, 'session/request_permission', {
    sessionId: 'native-session',
    toolCall: { toolCallId: 'tool-1', title: 'Read a record', kind: 'read', status: 'pending' },
    options: [{ optionId: 'allow', name: 'Allow once', kind: 'allow_once' }]
  })
  const text = client.prompt([{ type: 'text', text: 'Example prompt' }])
  const permissionResult = await requested
  expect(permission).toHaveBeenCalledTimes(1)
  expect(permissionResult).toMatchObject({
    result: { outcome: { outcome: 'selected', optionId: 'allow' } }
  })
  expect(await text).toMatchObject({ stopReason: 'end_turn' })
  const interrupted = client.prompt([{ type: 'text', text: 'Interrupted prompt' }])
  await vi.waitFor(() => expect(interruptedFrame).toBeDefined())
  await client.cancel()
  await expect(interrupted).resolves.toMatchObject({ stopReason: 'cancelled' })
  input.end()
  await vi.waitFor(() => expect(native!.exited).toBe(true))
  expect(
    (await readFile(join(root, 'native-home', 'antigravity-acp', 'settings.json'), 'utf8')).length
  ).toBeGreaterThan(0)
})

it('closes a failed start before creating a native session', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orca-external-launcher-failed-'))
  roots.push(root)
  await expect(
    startExternalAcpLauncher(profile(root), {
      tokenOverride: 'fixture-token',
      getToken: async () => {
        throw new Error('credential helper should not run')
      },
      createConnection: () => {
        throw new Error('startup refused')
      }
    })
  ).rejects.toThrow('startup refused')
})

it('preserves structured native failures without forwarding their payload', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orca-external-launcher-error-'))
  roots.push(root)
  let native: FakeAcpChild
  const input = new PassThrough()
  const output = new PassThrough()
  await startExternalAcpLauncher(profile(root), {
    input,
    output,
    tokenOverride: 'fixture-token',
    createConnection: (launch, connectionOptions) => {
      native = new FakeAcpChild(launch, connectionOptions)
      native.agent.on('initialize', (frame) => {
        native.agent.reply(frame, { protocolVersion: 1, agentCapabilities: {} })
      })
      native.agent.on('authenticate', (frame) => native.agent.reply(frame, {}))
      native.agent.on('session/new', (frame) =>
        native!.agent.reply(frame, { sessionId: 'native-session' })
      )
      native.agent.on('session/prompt', (frame) =>
        native!.agent.fail(frame, -32603, 'private native payload', {
          errorName: 'ServerUnavailable',
          privateDetail: 'do-not-forward'
        })
      )
      return native
    }
  })
  const client = new AcpSessionRuntime(output, input)
  await client.start({ cwd: '/workspace', mcpServers: [] })
  const failure = await client
    .prompt([{ type: 'text', text: 'Example prompt' }])
    .catch((error) => error)
  expect(failure).toMatchObject({ code: -32603, data: { errorName: 'ServerUnavailable' } })
  expect(failure.data.privateDetail).toBeUndefined()
  expect(failure.message).not.toContain('private native payload')
  input.end()
  await vi.waitFor(() => expect(native!.exited).toBe(true))
})

it('closes the native child when per-profile initialization fails', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orca-external-launcher-write-failure-'))
  roots.push(root)
  await writeFile(join(root, 'native-home'), 'not-a-directory')
  let native: FakeAcpChild
  await expect(
    startExternalAcpLauncher(profile(root), {
      input: new PassThrough(),
      output: new PassThrough(),
      tokenOverride: 'fixture-token',
      createConnection: (launch, connectionOptions) => {
        native = new FakeAcpChild(launch, connectionOptions)
        return native
      }
    })
  ).rejects.toThrow()
  expect(native!.exited).toBe(true)
})

it('closes the outer transport when the native process exits', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orca-external-launcher-native-exit-'))
  roots.push(root)
  const input = new PassThrough()
  const output = new PassThrough()
  let native: FakeAcpChild
  await startExternalAcpLauncher(profile(root), {
    input,
    output,
    tokenOverride: 'fixture-token',
    createConnection: (launch, connectionOptions) => {
      native = new FakeAcpChild(launch, connectionOptions)
      return native
    }
  })
  native!.exit()
  expect(output.writableEnded).toBe(true)
  expect(input.destroyed).toBe(true)
})

it('returns an invalid-request error for null and non-object frames', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orca-external-launcher-frame-guard-'))
  roots.push(root)
  const input = new PassThrough()
  const output = new PassThrough()
  await startExternalAcpLauncher(profile(root), {
    input,
    output,
    tokenOverride: 'fixture-token',
    createConnection: (launch, connectionOptions) => new FakeAcpChild(launch, connectionOptions)
  })
  output.setEncoding('utf8')
  const answer = new Promise<string>((resolve) => output.once('data', resolve))
  input.write('null\n')
  expect(JSON.parse(await answer)).toMatchObject({ id: null, error: { code: -32600 } })
  input.destroy()
})
