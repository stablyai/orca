import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES } from '../../../../shared/electron-remote-runtime-client-capabilities'
import { remoteRuntimeClientCapabilities } from '../../../../shared/remote-runtime-client-capabilities'
import { CURSOR_STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import * as protocol from '../../../../shared/protocol-version'
import { openTestAgentSessionRecordStore } from '../../agent-session-record-store-test-harness'
import { setStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-registry'
import type { StructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-host'
import type { RpcContext } from '../core'
import { agentLaunchSurfaceFactory } from './agent-launch-surfaces'
import { supportsCursorStructuredSessions } from './structured-agent-session-gate'
import { methodNamed, rpcContext, runtimeStub } from './agent-launch.test-fixture'

const createStructuredSession = vi.fn(async () => ({
  ok: true,
  value: { sessionId: 'cursor-independent', fence: 1 }
}))
vi.mock('./structured-agent-session-create', () => ({
  createStructuredAgentSessionForWorktree: () => createStructuredSession()
}))
const { AGENT_LAUNCH_METHODS } = await import('./agent-launch')
let directory: string
beforeEach(async () => {
  createStructuredSession.mockClear()
  directory = await mkdtemp(join(tmpdir(), 'orca-cursor-launch-admission-'))
  const store = await openTestAgentSessionRecordStore(directory)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: launch replay reads only deps.store; structured creation is recorded by the lower create seam.
  setStructuredAgentSessionHost({ deps: { store } } as unknown as StructuredAgentSessionHost)
})
afterEach(async () => {
  setStructuredAgentSessionHost(null)
  await rm(directory, { recursive: true, force: true })
})

it('keeps an older paired desktop launch on a surface its negotiated capabilities can read', async () => {
  const runtime = Object.assign(
    runtimeStub({
      settings: {
        experimentalNativeChat: true,
        experimentalStructuredNativeChat: false,
        openAgentTabsInChatByDefault: true
      }
    }),
    { selectCreatedMobileSessionTabForClient: vi.fn(() => true) }
  )
  const context = rpcContext(runtime, {
    clientKind: 'runtime',
    pairedDeviceId: 'independent-desktop',
    clientCapabilities: remoteRuntimeClientCapabilities(
      ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES
    ).filter((value) => value !== CURSOR_STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY)
  })
  expect(supportsCursorStructuredSessions(context)).toBe(false)
  const method = methodNamed(AGENT_LAUNCH_METHODS, 'agent.launch')
  const params = method.params.parse({
    agent: 'cursor',
    target: { kind: 'existing', worktree: 'folder:old-desktop' }
  })
  const result = await method.handler(params, context)
  expect({
    surface: result.outcome.kind,
    structuredCreates: createStructuredSession.mock.calls.length,
    terminalCreates: runtime.createTerminal.mock.calls.length
  }).toEqual({ surface: 'terminal', structuredCreates: 0, terminalCreates: 1 })
})

it('allows the current paired desktop through the same launch handler', async () => {
  const runtime = Object.assign(runtimeStub(), {
    selectCreatedMobileSessionTabForClient: vi.fn(() => true)
  })
  const context = rpcContext(runtime, {
    clientKind: 'runtime',
    pairedDeviceId: 'independent-desktop',
    clientCapabilities: remoteRuntimeClientCapabilities(ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES)
  })
  expect(supportsCursorStructuredSessions(context)).toBe(true)
  const method = methodNamed(AGENT_LAUNCH_METHODS, 'agent.launch')
  const result = await method.handler(
    method.params.parse({
      agent: 'cursor',
      target: { kind: 'existing', worktree: 'folder:current-desktop' }
    }),
    context
  )
  expect(result.outcome.kind).toBe('structured')
  expect(createStructuredSession).toHaveBeenCalledTimes(1)
  expect(runtime.createTerminal).not.toHaveBeenCalled()
})

const currentCapabilities = remoteRuntimeClientCapabilities(
  ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES
)
const oldCapabilities = currentCapabilities.filter(
  (value) => value !== CURSOR_STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY
)
// Read the advertised tokens without loading Expo's separate TypeScript project.
const mobileSource = readFileSync(
  new URL(
    '../../../../../mobile/src/transport/mobile-runtime-client-capabilities.ts',
    import.meta.url
  ),
  'utf8'
)
const mobileArray = mobileSource.split('remoteRuntimeClientCapabilities([')[1]?.split('])')[0]
if (!mobileArray) {
  throw new Error('Mobile capability advertisement not found')
}
const mobileTokens = [...mobileArray.matchAll(/^  ([A-Z][A-Z0-9_]+),?$/gm)].map((match) => match[1])
const mobileCapabilities = remoteRuntimeClientCapabilities(
  mobileTokens.map((name) => {
    const entry = Object.entries(protocol).find(([key]) => key === name)
    if (!entry || typeof entry[1] !== 'string') {
      throw new Error(`Unknown mobile capability ${name}`)
    }
    return entry[1]
  })
)
const clients: { name: string; context: Partial<RpcContext>; structured: boolean }[] = [
  {
    name: 'older paired desktop',
    context: {
      clientKind: 'runtime',
      pairedDeviceId: 'desktop',
      clientCapabilities: oldCapabilities
    },
    structured: false
  },
  {
    name: 'current paired desktop',
    context: {
      clientKind: 'runtime',
      pairedDeviceId: 'desktop',
      clientCapabilities: currentCapabilities
    },
    structured: true
  },
  {
    name: 'current mobile',
    context: {
      clientKind: 'mobile',
      pairedDeviceId: 'phone',
      clientCapabilities: mobileCapabilities
    },
    structured: false
  },
  { name: 'in-process caller', context: {}, structured: true }
]

it.each(
  clients.filter(
    (client) => client.name === 'current mobile' || client.name === 'in-process caller'
  )
)('preserves the readable legacy launch for $name', async ({ context: client, structured }) => {
  const runtime = Object.assign(runtimeStub(), {
    selectCreatedMobileSessionTabForClient: vi.fn(() => true)
  })
  const context = rpcContext(runtime, client)
  const method = methodNamed(AGENT_LAUNCH_METHODS, 'agent.launch')
  const result = await method.handler(
    method.params.parse({
      agent: 'cursor',
      target: { kind: 'existing', worktree: 'folder:legacy' }
    }),
    context
  )
  expect(result.outcome.kind).toBe(structured ? 'structured' : 'terminal')
  expect(createStructuredSession).toHaveBeenCalledTimes(structured ? 1 : 0)
  expect(runtime.createTerminal).toHaveBeenCalledTimes(structured ? 0 : 1)
})

for (const name of ['agent.launch', 'agent.launchReplay'] as const) {
  it.each(clients)(
    `${name} admits $name before creation and replays one recorded surface`,
    async ({ context: client, structured }) => {
      const runtime = Object.assign(runtimeStub(), {
        selectCreatedMobileSessionTabForClient: vi.fn(() => true)
      })
      const context = rpcContext(runtime, client)
      const method = methodNamed(AGENT_LAUNCH_METHODS, name)
      const parsed = method.params.parse({
        operationId: `${Date.now()}-000000000000000000000000000000aa`,
        agent: 'cursor',
        target: { kind: 'existing', worktree: 'folder:replay' },
        sessionOptions: { model: 'cursor-model', effort: 'high' }
      })
      if (!parsed.operationId) {
        throw new Error('Replay operation id missing')
      }
      const params = { ...parsed, operationId: parsed.operationId }
      const result = await method.handler(params, context)
      expect(result.outcome.kind).toBe(structured ? 'structured' : 'terminal')
      expect(await method.handler(params, context)).toEqual(result)
      expect(createStructuredSession).toHaveBeenCalledTimes(structured ? 1 : 0)
      expect(runtime.createTerminal).toHaveBeenCalledTimes(structured ? 0 : 1)
      if (!structured) {
        expect(runtime.createTerminal).toHaveBeenCalledWith(
          'id:folder:replay',
          expect.objectContaining({
            startupAgent: 'cursor',
            launchPreferences: { model: 'cursor-model', effort: 'high' }
          })
        )
      }
    }
  )
}

it('refuses the canonical structured factory before the lower create seam', async () => {
  const runtime = runtimeStub()
  const context = rpcContext(runtime, clients[0].context)
  await expect(
    agentLaunchSurfaceFactory(context).createStructuredSession({
      worktreeId: 'folder:refused',
      agent: 'cursor'
    })
  ).rejects.toMatchObject({ code: 'structured_agent_session_unsupported' })
  expect(createStructuredSession).not.toHaveBeenCalled()
  expect(runtime.ensureStructuredAgentSessionHost).not.toHaveBeenCalled()
  expect(runtime.createTerminal).not.toHaveBeenCalled()
})

it('keeps an unknown Cursor commit outcome from duplicating work after capability loss', async () => {
  const runtime = Object.assign(runtimeStub(), {
    selectCreatedMobileSessionTabForClient: vi.fn(() => true)
  })
  const method = methodNamed(AGENT_LAUNCH_METHODS, 'agent.launchReplay')
  const params = method.params.parse({
    operationId: `${Date.now()}-000000000000000000000000000000bb`,
    agent: 'cursor',
    target: { kind: 'existing', worktree: 'folder:unknown' }
  })
  createStructuredSession.mockRejectedValueOnce(new Error('agent_session_operation_unknown'))
  await expect(method.handler(params, rpcContext(runtime, clients[1].context))).rejects.toThrow(
    'agent_session_operation_unknown'
  )
  await expect(method.handler(params, rpcContext(runtime, clients[0].context))).rejects.toThrow(
    'agent_session_operation_unknown'
  )
  expect(createStructuredSession).toHaveBeenCalledTimes(1)
  expect(runtime.createTerminal).not.toHaveBeenCalled()
})
