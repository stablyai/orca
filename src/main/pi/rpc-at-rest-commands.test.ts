import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { agentSessionRecordFixture } from '../native-chat/agent-session-record-test-fixture'
import { PiAtRestCommandCatalog } from './rpc-at-rest-commands'
import { FakeConnection } from './rpc-session-adapter.test-fixture'
import type { ProviderProcessLaunch } from '../provider-process/provider-process-launch'

const catalogs: PiAtRestCommandCatalog[] = []
const folders: string[] = []

afterEach(async () => {
  await Promise.all(catalogs.splice(0).map((catalog) => catalog.closeAll()))
  await Promise.all(folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true })))
})

async function rig(request?: (command: string) => Promise<unknown> | undefined) {
  const cwd = await mkdtemp(join(tmpdir(), 'orca-pi-commands-'))
  folders.push(cwd)
  const children: FakeConnection[] = []
  const launches: ProviderProcessLaunch[] = []
  const record = agentSessionRecordFixture({
    sessionId: 'new-pi-chat',
    provider: 'pi',
    accountHome: { variable: 'PI_CODING_AGENT_DIR', path: join(cwd, 'pi-account') }
  })
  const catalog = new PiAtRestCommandCatalog({
    resolveWorkspacePath: async () => cwd,
    resolveEnvironment: async () => ({
      PATH: process.env.PATH,
      ORCA_PANE_KEY: 'parent-pane',
      ORCA_AGENT_SESSION_ID: 'parent-session',
      ORCA_AGENT_SESSION_SPAWN_TOKEN: 'parent-token'
    }),
    resolveCommand: () => process.execPath,
    probeVersion: async () => ({ version: '1.5.0' }),
    connect: (launch) => {
      launches.push(launch)
      const child = new FakeConnection({})
      child.requestOverride = request
      children.push(child)
      return child
    }
  })
  catalogs.push(catalog)
  return { catalog, record, children, launches, cwd }
}

it('discovers Pi extension commands, prompt templates and skills before a chat starts, then closes the sessionless probe', async () => {
  const { catalog, record, children, launches, cwd } = await rig(async (command) => {
    if (command !== 'get_commands') {
      throw new Error(`Unexpected model/session request: ${command}`)
    }
    // Pi 1.5.0 get_commands response shape, including package-only resources.
    return {
      commands: [
        { name: 'subagents', source: 'extension', description: 'Administer subagents' },
        { name: 'parallel-review', source: 'prompt', description: 'Parallel subagents review' },
        {
          name: 'skill:pi-subagents',
          source: 'skill',
          description: 'Delegate work to Pi subagents'
        }
      ]
    }
  })

  expect(await catalog.settled(record, 1_000, true)).toEqual([
    { name: 'subagents', kind: 'command', description: 'Administer subagents' },
    { name: 'parallel-review', kind: 'command', description: 'Parallel subagents review' },
    { name: 'skill:pi-subagents', kind: 'skill', description: 'Delegate work to Pi subagents' }
  ])
  await catalog.closeAll()
  expect(launches[0]).toMatchObject({
    command: process.execPath,
    cwd,
    args: ['--mode', 'rpc', '--no-session'],
    env: { PI_CODING_AGENT_DIR: join(cwd, 'pi-account') },
    envToDelete: expect.arrayContaining([
      'ORCA_PANE_KEY',
      'ORCA_AGENT_SESSION_ID',
      'ORCA_AGENT_SESSION_SPAWN_TOKEN'
    ])
  })
  expect(launches[0].env).not.toHaveProperty('ORCA_AGENT_SESSION_ID')
  expect(children[0].requests).toEqual(['get_commands'])
  expect(children[0].lastCloseResult).toEqual({ root: 'exited', tree: 'exited' })
})

it('shutdown cancels a pending discovery and waits for its connection to close', async () => {
  const requested = Promise.withResolvers<void>()
  const closing = Promise.withResolvers<void>()
  const drained = Promise.withResolvers<void>()
  const { catalog, record, children } = await rig(async () => {
    requested.resolve()
    return new Promise<never>(() => {})
  })
  catalog.read(record)
  await requested.promise
  const close = children[0].close.bind(children[0])
  vi.spyOn(children[0], 'close').mockImplementation(async () => {
    closing.resolve()
    await drained.promise
    return close()
  })
  let stopped = false
  const stop = catalog.closeAll().then(() => {
    stopped = true
  })
  try {
    await closing.promise
    expect(stopped).toBe(false)
  } finally {
    drained.resolve()
    await stop
  }
  expect(children[0].lastCloseResult).toEqual({ root: 'exited', tree: 'exited' })
  expect(catalog.read(record)).toBeUndefined()
})
