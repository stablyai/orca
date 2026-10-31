import { mkdtemp, readdir, rm, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type * as OmpRpcLaunch from './rpc-launch'
import { openOmpRpcConnection } from './rpc-connection'
import { resolveOmpRpcInvocation } from './rpc-launch'
import { createOmpRpcAtRestCommands } from './rpc-at-rest-commands'
import { FakeConnection } from '../pi/rpc-session-adapter.test-fixture'
import { agentSessionRecordFixture } from '../native-chat/agent-session-record-test-fixture'
import { isWindowsProcessStartTimeAvailable } from '../windows/windows-process-table'
import type { StructuredAgentModelCatalogContext } from '../runtime/structured-agent-runtime-registration-types'

vi.mock('./rpc-connection', () => ({ openOmpRpcConnection: vi.fn() }))
vi.mock('./rpc-launch', async (importOriginal) => ({
  ...(await importOriginal<typeof OmpRpcLaunch>()),
  resolveOmpRpcInvocation: vi.fn()
}))
vi.mock('../windows/windows-process-table', () => ({ isWindowsProcessStartTimeAvailable: vi.fn() }))

let root: string
let context: StructuredAgentModelCatalogContext
const catalogs: ReturnType<typeof createOmpRpcAtRestCommands>[] = []
beforeEach(async () => {
  vi.resetAllMocks()
  vi.mocked(isWindowsProcessStartTimeAvailable).mockReturnValue(true)
  root = await mkdtemp(join(tmpdir(), 'orca-omp-commands-'))
  context = {
    deps: {
      stateDirectory: root,
      hostId: 'local',
      claimKeyId: 'test',
      resolveWorkspacePath: async (id) => join(root, id),
      resolveLaunchArgs: async () => [],
      resolveClaudeAuthPolicy: () => ({ account: 'system' }),
      logger: { warn: vi.fn(), error: vi.fn() }
    },
    environment: {
      resolveBaseEnvironment: async () => ({}),
      resolveAgentEnvironment: async () => ({}),
      refreshAfterMissingProgram: async () => {},
      bindCatalogSources: () => () => {}
    }
  }
  vi.mocked(resolveOmpRpcInvocation).mockImplementation(async (input) => ({
    command: 'omp',
    prefixArgs: [],
    env: { PI_CODING_AGENT_DIR: input.accountDir }
  }))
})
afterEach(async () => {
  catalogs.splice(0).forEach((catalog) => catalog.dispose())
  await rm(root, { recursive: true, force: true })
})

function catalog() {
  const value = createOmpRpcAtRestCommands(context)
  catalogs.push(value)
  return value
}
function record(workspace: string, account = 'account') {
  return agentSessionRecordFixture({
    sessionId: `session-${workspace}-${account}`,
    provider: 'omp',
    accountHome: { variable: 'PI_CODING_AGENT_DIR', path: join(root, account) },
    location: { workspaceId: workspace, workspaceKind: 'folder' },
    launchArgs: ['-e', 'commands.mjs']
  })
}

it('discovers native commands and skills before sending, isolates folders/accounts, and refreshes on retirement', async () => {
  await Promise.all(['one', 'two'].map((id) => mkdir(join(root, id))))
  const connections: FakeConnection[] = []
  let revision = 0
  vi.mocked(openOmpRpcConnection).mockImplementation((launch, handlers) => {
    const connection = new FakeConnection(handlers)
    connection.requestOverride = (command) =>
      command === 'get_commands'
        ? Promise.resolve({
            commands: [
              { name: 'mcp', source: 'builtin' },
              {
                name: `${launch.cwd}:${launch.env?.PI_CODING_AGENT_DIR}:${revision}`,
                source: 'skill',
                description: 'Loaded by OMP'
              }
            ]
          })
        : undefined
    connections.push(connection)
    expect(launch.args).toEqual(
      expect.arrayContaining(['--mode', 'rpc-ui', '-e', 'commands.mjs', '--session-dir'])
    )
    return connection
  })
  const source = catalog()
  const first = record('one')
  expect(source.read(first)).toBeUndefined()
  const listed = await source.settled(first, 1000)
  expect(listed).toEqual([
    { name: 'mcp', kind: 'command' },
    {
      name: `${join(root, 'one')}:${join(root, 'account')}:0`,
      kind: 'skill',
      description: 'Loaded by OMP'
    }
  ])
  const otherFolder = await source.settled(record('two'), 1000)
  const otherAccount = await source.settled(record('one', 'another'), 1000)
  expect(otherFolder).not.toEqual(listed)
  expect(otherAccount).not.toEqual(listed)
  expect(source.read(first)).toEqual(listed)
  revision++
  source.retireContext('one')
  expect(await source.settled(first, 1000)).not.toEqual(listed)
  await vi.waitFor(() => expect(connections.every((connection) => connection.closed)).toBe(true))
  expect(connections.flatMap((connection) => connection.sent)).toEqual([])
  expect(await readdir(join(root, 'omp-rpc'))).toEqual([])
})

it('closes a discovery process on retirement and never publishes its late commands', async () => {
  await mkdir(join(root, 'one'))
  const reply = Promise.withResolvers<unknown>()
  const connection = new FakeConnection({})
  connection.requestOverride = (command) => (command === 'get_commands' ? reply.promise : undefined)
  vi.mocked(openOmpRpcConnection).mockReturnValue(connection)
  const source = catalog()
  const changed = vi.fn()
  source.onChange(changed)
  source.read(record('one'))
  await vi.waitFor(() => expect(connection.requests).toContain('get_commands'))
  source.dispose()
  await vi.waitFor(() => expect(connection.closed).toBe(true))
  reply.resolve({ commands: [{ name: 'late', source: 'skill' }] })
  expect(source.read(record('one'))).toBeUndefined()
  expect(changed).not.toHaveBeenCalled()
  await vi.waitFor(async () => expect(await readdir(join(root, 'omp-rpc'))).toEqual([]))
})
