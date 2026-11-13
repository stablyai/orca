import { createAcpModelCatalogProbe } from '../../acp/discovery/acp-model-catalog-probe'
import { acpLaunchSpecFor } from '../../acp/launch/acp-launch-registry'
import { mkdtemp, writeFile, readFile, rm, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname, delimiter } from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import { agentModelCatalogInputStamp } from './agent-model-catalog-input-stamp'
import { createAgentModelCatalogService } from './agent-model-catalog-service'
import { AgentModelCatalogStore } from './agent-model-catalog-store'
import type { AgentModelCatalogSuccess } from './agent-model-catalog-entry'
import type { AgentModelCatalogProbe } from './agent-model-catalog-discovery'

it.each(['grok', 'codex'])(
  'observes %s installs before deciding freshness, ignoring probe-owned writes',
  async (agent) => {
    const folder = await mkdtemp(join(tmpdir(), 'orca-catalog-inputs-'))
    onTestFinished(() => rm(folder, { recursive: true, force: true }))
    const script = join(folder, 'cli.js')
    const config = join(folder, 'settings.json')
    await writeFile(script, 'version-one')
    await writeFile(config, '{}')
    let model = 'first'
    const resolve = async () => ({
      identity: 'same-invocation',
      inputStamp: await agentModelCatalogInputStamp({
        command: process.execPath,
        prefixArgs: [script],
        cwd: folder,
        env: {},
        configFiles: [config]
      }),
      run: async () => ({
        models: [{ id: model, label: model, efforts: [], isDefault: true }],
        origin: 'probe' as const
      })
    })
    const probe: AgentModelCatalogProbe = Object.assign(
      async () => {
        throw new Error('unresolved')
      },
      { resolve, resolveLegacy: resolve }
    )
    const service = createAgentModelCatalogService({
      store: new AgentModelCatalogStore(),
      getConversation: () => undefined,
      getRecord: () => undefined,
      drivesRecord: () => true,
      resolveAccountHome: async () => ({
        variable: agent === 'codex' ? 'CODEX_HOME' : 'GROK_HOME',
        path: folder
      }),
      probes: { [agent]: probe }
    })
    onTestFinished(() => service.stop())
    const read = () =>
      service.read({
        agent,
        legacy: agent === 'codex',
        workspacePath: folder,
        waitForListing: true
      })
    expect(await read()).toMatchObject({ models: [{ id: 'first' }] })
    model = 'second'
    await writeFile(join(folder, '.claude.json'), 'probe usage')
    await read()
    expect(await read()).toMatchObject({ models: [{ id: 'first' }] })
    await writeFile(script, 'version-two-with-new-model')
    expect(await read()).toMatchObject({ models: [{ id: 'second' }] })
    model = 'configured'
    await writeFile(config, '{"model":"configured"}')
    expect(await read()).toMatchObject({ models: [{ id: 'configured' }] })
  }
)

it('resolves relative PATH installs and direct interpreter scripts from their actual cwd', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'orca-catalog-relative-'))
  onTestFinished(() => rm(folder, { recursive: true, force: true }))
  const command = join(folder, 'bin', process.platform === 'win32' ? 'node.exe' : 'node')
  await mkdir(dirname(command), { recursive: true })
  await writeFile(command, 'install-one', { mode: 0o755 })
  await writeFile(join(folder, 'cli.js'), 'script-one')
  const input = { command: 'node', prefixArgs: ['cli.js'], cwd: folder, env: { PATH: 'bin' } }
  const before = await agentModelCatalogInputStamp(input)
  await writeFile(command, 'install-two-new')
  const installed = await agentModelCatalogInputStamp(input)
  expect(installed).not.toBe(before)
  await writeFile(join(folder, 'cli.js'), 'script-two-new')
  expect(await agentModelCatalogInputStamp(input)).not.toBe(installed)
})

it('shares unchanged executable evidence across folders and irrelevant PATH entries', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'orca-catalog-lookup-'))
  onTestFinished(() => rm(folder, { recursive: true, force: true }))
  const a = join(folder, 'a')
  const b = join(folder, 'b')
  await Promise.all([mkdir(a), mkdir(b)])
  const store = new AgentModelCatalogStore()
  const held = Promise.withResolvers<AgentModelCatalogSuccess>()
  let started = false
  const run = async () => {
    if (started) {
      return {
        models: [{ id: 'duplicate', label: 'Duplicate', efforts: [], isDefault: true }],
        origin: 'probe' as const,
        complete: true
      }
    }
    started = true
    return held.promise
  }
  const probe: AgentModelCatalogProbe = Object.assign(run, {
    resolve: async (
      _home: unknown,
      _listIn: string,
      _lookup?: unknown,
      _operation?: unknown,
      cwd = _listIn
    ) => ({
      identity: 'same-executable',
      inputStamp: await agentModelCatalogInputStamp({
        command: process.execPath,
        cwd,
        env: {
          PATH: `./node_modules/.bin${delimiter}${folder}/${cwd === a ? 'unused-one' : 'unused-two'}${delimiter}`
        }
      }),
      run
    })
  })
  const service = createAgentModelCatalogService({
    store,
    getConversation: () => undefined,
    getRecord: () => undefined,
    drivesRecord: () => true,
    resolveAccountHome: async () => ({ variable: 'CLAUDE_CONFIG_DIR', path: folder }),
    probes: { claude: probe }
  })
  onTestFinished(() => service.stop())
  await service.read({ agent: 'claude', workspacePath: a })
  await service.read({ agent: 'claude', workspacePath: b })
  held.resolve({
    models: [{ id: 'retained', label: 'Retained', efforts: [], isDefault: true }],
    origin: 'probe',
    complete: true
  })
  expect(
    await service.read({ agent: 'claude', workspacePath: b, waitForListing: true })
  ).toMatchObject({ models: [{ id: 'retained' }] })
  expect(
    await service.read({ agent: 'claude', workspacePath: a, waitForListing: true })
  ).toMatchObject({ models: [{ id: 'retained' }] })
})

it.each(['bun', 'deno'])(
  'observes the direct %s run operand rather than the run subcommand',
  async (command) => {
    const folder = await mkdtemp(join(tmpdir(), 'orca-catalog-script-'))
    onTestFinished(() => rm(folder, { recursive: true, force: true }))
    await writeFile(join(folder, 'agent.ts'), 'one')
    const input = { command, prefixArgs: ['run', 'agent.ts'], cwd: folder, env: {} }
    const original = await agentModelCatalogInputStamp(input)
    await writeFile(join(folder, 'run'), 'unrelated')
    expect(await agentModelCatalogInputStamp(input)).toBe(original)
    await writeFile(join(folder, 'agent.ts'), 'replacement-script')
    expect(await agentModelCatalogInputStamp(input)).not.toBe(original)
  }
)

it('observes the real ACP legacy command script in its listing folder before using saved rows', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'orca-catalog-legacy-acp-'))
  onTestFinished(() => rm(folder, { recursive: true, force: true }))
  const home = join(folder, 'home')
  const workspace = join(folder, 'workspace')
  await Promise.all([mkdir(home), mkdir(workspace)])
  await writeFile(join(home, 'agent.js'), 'home-model')
  await writeFile(join(workspace, 'agent.js'), 'workspace-model')
  const probe = createAcpModelCatalogProbe(
    {
      ...acpLaunchSpecFor('grok')!,
      minimumVersions: undefined,
      modelDiscovery: {
        kind: 'command',
        args: [],
        listingNamesConfiguredModel: true,
        parse: (id) => [{ id, label: id, efforts: [], isDefault: true }]
      }
    },
    {
      homePath: home,
      dataDirectory: folder,
      resolveEnvironment: async () => ({}),
      resolveCommandSettings: () => ({
        agentCmdOverrides: { grok: `"${process.execPath}" agent.js` }
      }),
      runListing: async (launch) => readFile(join(launch.cwd!, launch.args[0]!), 'utf8')
    }
  )
  const store = new AgentModelCatalogStore()
  const service = createAgentModelCatalogService({
    store,
    getConversation: () => undefined,
    getRecord: () => undefined,
    drivesRecord: () => true,
    resolveAccountHome: async () => ({ variable: 'GROK_HOME', path: home }),
    probes: { grok: probe }
  })
  onTestFinished(() => service.stop())
  const read = () =>
    service.read({ agent: 'grok', legacy: true, workspacePath: workspace, waitForListing: true })
  expect(await read()).toMatchObject({ models: [{ id: 'workspace-model' }] })
  await writeFile(join(workspace, 'agent.js'), 'upgraded-workspace-model')
  expect(await read()).toMatchObject({ models: [{ id: 'upgraded-workspace-model' }] })
})
