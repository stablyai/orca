import { createAcpModelCatalogProbe } from '../../acp/discovery/acp-model-catalog-probe'
import { acpLaunchSpecFor } from '../../acp/launch/acp-launch-registry'
import { openCodeAcpAccountBinding } from '../../opencode/accounts/opencode-structured-account-home'
import { ManagedDataAccountService } from '../../managed-data-accounts/service'
import { mkdtemp, writeFile, readFile, rm, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import { agentModelCatalogInputStamp } from './agent-model-catalog-input-stamp'
import { agentModelCatalogScriptEntry } from './agent-model-catalog-script-entry'
import { createAgentModelCatalogService } from './agent-model-catalog-service'
import { AgentModelCatalogStore } from './agent-model-catalog-store'
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
  const read = async () => {
    const params = { agent: 'grok', legacy: true, workspacePath: workspace, waitForListing: true }
    await service.demand(params)
    return service.read(params)
  }
  expect(await read()).toMatchObject({ models: [{ id: 'workspace-model' }] })
  await writeFile(join(workspace, 'agent.js'), 'upgraded-workspace-model')
  expect(await read()).toMatchObject({ models: [{ id: 'upgraded-workspace-model' }] })
})

it.each([
  ['node', '--no-warnings'],
  ['python3', '-u']
])('refreshes a cached catalog when the %s script after an option changes', async (name, flag) => {
  const folder = await mkdtemp(join(tmpdir(), 'orca-catalog-flagged-'))
  onTestFinished(() => rm(folder, { recursive: true, force: true }))
  const home = join(folder, 'home')
  const workspace = join(folder, 'workspace')
  await Promise.all([mkdir(home), mkdir(workspace)])
  const executable = join(folder, process.platform === 'win32' ? `${name}.exe` : name)
  await writeFile(executable, 'fixture interpreter', { mode: 0o755 })
  await writeFile(join(home, 'agent.js'), 'qa/home')
  await writeFile(join(workspace, 'agent.js'), 'qa/first')
  const accounts = new ManagedDataAccountService(join(folder, 'profiles'))
  const probe = createAcpModelCatalogProbe(
    {
      ...acpLaunchSpecFor('opencode')!,
      account: openCodeAcpAccountBinding(() => accounts)
    },
    {
      homePath: home,
      dataDirectory: folder,
      resolveEnvironment: async () => ({}),
      resolveCommandSettings: () => ({
        agentCmdOverrides: { opencode: `"${executable}" ${flag} agent.js` }
      }),
      probeVersion: async (input) => {
        expect(input).toMatchObject({
          program: executable,
          prefixArgs: [flag, 'agent.js'],
          cwd: home
        })
        return { version: '1.19.5' }
      },
      runListing: async (launch) => {
        expect(launch).toMatchObject({
          command: executable,
          args: [flag, 'agent.js', 'models', '--verbose'],
          cwd: workspace
        })
        return readFile(join(workspace, 'agent.js'), 'utf8')
      }
    }
  )
  const service = createAgentModelCatalogService({
    store: new AgentModelCatalogStore(),
    getConversation: () => undefined,
    getRecord: () => undefined,
    drivesRecord: () => true,
    resolveAccountHome: async () => ({ kind: 'opencode', locator: { kind: 'unmanaged' } }),
    listsInChatFolder: new Set(['opencode']),
    probes: { opencode: probe }
  })
  onTestFinished(() => service.stop())
  const read = () =>
    service.read({ agent: 'opencode', workspacePath: workspace, waitForListing: true })
  expect(await read()).toMatchObject({ models: [{ id: 'qa/first' }] })
  await writeFile(join(workspace, 'agent.js'), 'qa/upgraded-script')
  expect(await read()).toMatchObject({ models: [{ id: 'qa/upgraded-script' }] })
})

it.each([
  { command: 'node', args: ['--trace-warnings', '--no-warnings', 'agent.js', 'argument.txt'] },
  { command: 'node', args: ['-r', 'preload.js', '--import=loader.js', 'agent.js', 'argument.txt'] },
  { command: 'node', args: ['--', '-agent.js'], script: '-agent.js' },
  { command: 'python3', args: ['-u', '-W', 'ignore', '-Xdev', 'agent.js', 'argument.txt'] },
  { command: 'deno', args: ['run', '-A', '--allow-read', 'agent.js', 'argument.txt'] },
  {
    command: 'deno',
    args: [
      'run',
      '--allow-read=permission.txt',
      '--config',
      'config.json',
      '--import-map=map.json',
      'agent.js'
    ]
  }
])(
  'stamps only the direct file in $command $args',
  async ({ command, args, script = 'agent.js' }) => {
    const folder = await mkdtemp(join(tmpdir(), 'orca-catalog-operand-'))
    onTestFinished(() => rm(folder, { recursive: true, force: true }))
    await writeFile(join(folder, script), 'original script')
    const input = { command, prefixArgs: args, cwd: folder, env: {} }
    const original = await agentModelCatalogInputStamp(input)
    for (const name of [
      'preload.js',
      'loader.js',
      'ignore',
      'permission.txt',
      'config.json',
      'map.json',
      'argument.txt'
    ]) {
      await writeFile(join(folder, name), 'unselected file changed')
    }
    expect(await agentModelCatalogInputStamp(input)).toBe(original)
    await writeFile(join(folder, script), 'replacement entry script')
    expect(await agentModelCatalogInputStamp(input)).not.toBe(original)
  }
)

it.skipIf(process.platform === 'win32')(
  'observes a Node literal filename containing a colon',
  async () => {
    const folder = await mkdtemp(join(tmpdir(), 'orca-catalog-colon-'))
    onTestFinished(() => rm(folder, { recursive: true, force: true }))
    const script = join(folder, 'agent:stable.cjs')
    await writeFile(script, 'original script')
    const input = { command: 'node', prefixArgs: ['agent:stable.cjs'], cwd: folder, env: {} }
    const original = await agentModelCatalogInputStamp(input)
    await writeFile(script, 'replacement entry script')
    expect(await agentModelCatalogInputStamp(input)).not.toBe(original)
  }
)

it.each<[string, string[]]>([
  ['node', ['--unknown', 'candidate.js', 'agent.js']],
  ['node', ['--no-warnings=true', 'candidate.js']],
  ['node', ['--require', '--', 'candidate.js']],
  ['node', ['--require=', 'candidate.js']],
  ['node', ['-rpreload.js', 'candidate.js']],
  ['node', ['--eval=candidate.js', 'agent.js']],
  ['node', ['-p', 'candidate.js', 'agent.js']],
  ['node', ['inspect', 'candidate.js']],
  ['node', ['-', 'candidate.js']],
  ['node', ['--']],
  ['python3', ['-c', 'candidate.js', 'agent.js']],
  ['python3', ['-mcandidate.js', 'agent.js']],
  ['python3', ['-uB', 'candidate.js']],
  ['deno', ['run', '--unknown=value', 'candidate.js']],
  ['deno', ['run', '--allow-fictional', 'candidate.js']],
  ['deno', ['run', '--config', '--', 'candidate.js']],
  ['deno', ['run', '--allow-read=', 'candidate.js']],
  ['deno', ['run', 'npm:candidate.js']],
  ['deno', ['run', 'https://example.com/candidate.js']],
  ['deno', ['run', '-', 'candidate.js']]
])('does not guess a file for opaque %s arguments %j', async (command, args) => {
  const folder = await mkdtemp(join(tmpdir(), 'orca-catalog-opaque-'))
  onTestFinished(() => rm(folder, { recursive: true, force: true }))
  const input = { command, prefixArgs: args, cwd: folder, env: {} }
  const original = await agentModelCatalogInputStamp(input)
  await writeFile(join(folder, 'candidate.js'), 'not an identified file')
  await writeFile(join(folder, 'agent.js'), 'not an identified file')
  expect(await agentModelCatalogInputStamp(input)).toBe(original)
})

it('recognizes a Deno Windows file without treating its drive as a URI scheme', () => {
  expect(agentModelCatalogScriptEntry('deno', ['run', '-A', 'C:\\tools\\agent.ts'])).toBe(
    'C:\\tools\\agent.ts'
  )
})
