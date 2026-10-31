import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import {
  hostTestMessage,
  HOST_TEST_SESSION as SESSION
} from '../../native-chat/agent-session-wire/host/testing/structured-agent-session-host-test-data'
import { createTestParams } from '../../native-chat/agent-session-wire/host/testing/structured-agent-session-create-test-fixture'
import { createStructuredAgentSessionLogger } from '../../native-chat/agent-session-wire/host/structured-agent-session-logger'
import { piScriptedChild } from '../../pi/pi-scripted-child.test-fixture'
import { piRpcSeededLaunch } from '../../pi/rpc-launch-seeds'
import {
  ensureStructuredAgentSessionHost,
  stopStructuredAgentSessionRuntime
} from './structured-agent-session-runtime'

const GPT = {
  provider: 'openai-codex',
  id: 'gpt-6.1-sol',
  reasoning: true,
  thinkingLevelMap: { low: 'low', medium: 'medium', high: 'high' }
}
const CALLER = { callerKey: 'pi-seeded-launch-test' }

let directory: string | undefined
let operations = 0
const operationId = () => `${Date.now()}-${(++operations).toString(16).padStart(32, '0')}`

afterEach(async () => {
  await stopStructuredAgentSessionRuntime()
  if (directory) {
    await rm(directory, { recursive: true, force: true })
    directory = undefined
  }
})

async function openSeededChat(args: { options: Record<string, string>; model?: typeof GPT }) {
  directory = await mkdtemp(join(tmpdir(), 'orca-pi-seeded-'))
  const root = directory
  const script = piScriptedChild(args.model ? { model: args.model } : {})
  // The host resolves the launch; seed it here and keep the argv each child actually got.
  const seeded = piRpcSeededLaunch(args.options)
  const resolveLaunch = script.deps.resolvePiLaunch
  if (!resolveLaunch) {
    throw new Error('scripted Pi declares no launch resolver')
  }
  script.deps.resolvePiLaunch = async (input) => ({
    ...(await resolveLaunch(input)),
    extraArgs: seeded.extraArgs,
    launchIntent: seeded.launchIntent
  })
  const openConnection = script.deps.openPiConnection
  if (!openConnection) {
    throw new Error('scripted Pi declares no connection opener')
  }
  const argv: string[][] = []
  script.deps.openPiConnection = (spec, handlers) => {
    argv.push([...spec.args])
    return openConnection(spec, handlers)
  }
  const host = await ensureStructuredAgentSessionHost({
    logger: createStructuredAgentSessionLogger(),
    stateDirectory: root,
    hostId: 'local',
    claimKeyId: 'key-1',
    resolveWorkspacePath: async () => root,
    resolveClaudeAuthPolicy: () => ({ account: 'managed' }),
    resolveLaunchArgs: () => [],
    resolveEnvironment: async () => ({}),
    ...script.deps
  })
  const firstMessage = { clientMessageId: operationId(), body: hostTestMessage('worker task') }
  const params = createTestParams(
    firstMessage,
    {
      options: args.options,
      provider: 'pi',
      agent: 'pi',
      providerHandle: undefined,
      accountHome: { variable: 'PI_CODING_AGENT_DIR', path: root },
      location: {
        executionHostId: 'local',
        wslDistro: null,
        workspaceId: 'folder-1',
        workspaceKind: 'folder'
      }
    },
    SESSION
  )
  params.envelope.clientOperationId = operationId()
  const created = await host.create(CALLER, params, { firstMessage })
  if (!created.ok) {
    throw new Error(JSON.stringify(created.refusal))
  }
  await vi.waitFor(() => expect(script.spawns()).toBe(1))
  return { script, host, argv }
}

const optionsSent = (script: ReturnType<typeof piScriptedChild>) =>
  script
    .inputs()
    .filter(({ command }) => command.startsWith('set_') || command === 'prompt')
    .map(({ command, params }) => ({ command, params }))

it('starts a seeded chat on its model and thinking level, sending no RPC switch', async () => {
  const seed = { model: 'openai-codex/gpt-6.1-sol', effort: 'low' }
  const h = await openSeededChat({ options: seed, model: GPT })
  expect(h.argv[0]).toEqual([
    '--mode',
    'rpc',
    '--model',
    'openai-codex/gpt-6.1-sol',
    '--thinking',
    'low'
  ])
  h.script.releaseHandshake()
  await vi.waitFor(() => expect(h.script.prompts()).toEqual(['worker task']))
  expect(optionsSent(h.script)).toMatchObject([
    { command: 'prompt', params: { message: 'worker task', effort: 'low' } }
  ])
})

it('submits the opening prompt for a fuzzy selector Pi resolved to another model', async () => {
  // Pi matches `--model` by pattern: the launch sends `gpt-6.1-sol`, Pi runs the canonical id.
  const h = await openSeededChat({ options: { model: 'gpt-6.1-sol', effort: 'low' }, model: GPT })
  expect(h.argv[0]).toEqual(['--mode', 'rpc', '--model', 'gpt-6.1-sol', '--thinking', 'low'])
  h.script.releaseHandshake()
  await vi.waitFor(() => expect(h.script.prompts()).toEqual(['worker task']))
  // The launch selector stays current, so the opening prompt is not lost to a rejected set_model.
  expect(h.script.wire()).not.toContain('set_model')
  expect(optionsSent(h.script)).toMatchObject([
    { command: 'prompt', params: { message: 'worker task', effort: 'low' } }
  ])
})
