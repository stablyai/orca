import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import type { AcpModelCatalogSessionConnection } from '../acp/discovery/acp-listing-session-models'
import { createAcpModelCatalogProbe } from '../acp/discovery/acp-model-catalog-probe'
import { createAgentModelCatalogService } from '../native-chat/agent-model-catalog/agent-model-catalog-service'
import { AgentModelCatalogStore } from '../native-chat/agent-model-catalog/agent-model-catalog-store'
import { createStructuredAgentEnvironmentResolvers } from '../runtime/agent-session/environment/structured-agent-shell-environment'
import type { StructuredAgentModelCatalogContext } from '../runtime/agent-session/installation/structured-agent-runtime-registration-types'
import { acpModelCatalogDiscovery } from '../runtime/agent-session/model-catalog/structured-agent-model-catalog-discovery'
import { HERMES_LAUNCH_SPEC } from './hermes-acp-launch-spec'
import { discardHermesListingSession } from './hermes-listing-session'

const SESSION_ID = 'hermes-listing-1'
const MODELS = [
  { modelId: 'openai:gpt-5', name: 'OpenAI · gpt-5' },
  { modelId: 'anthropic:claude-sonnet', name: 'Anthropic · claude-sonnet' }
]

it('lists Hermes models when a catalog read asks and deletes the listing session', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orca-hermes-catalog-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const home = join(root, 'hermes-home')
  await mkdir(home, { recursive: true })
  const log = join(root, 'deletes.log')
  const script = join(root, 'hermes-delete.mjs')
  await writeFile(
    script,
    [
      "import { appendFileSync } from 'node:fs'",
      'appendFileSync(',
      '  process.env.ORCA_HERMES_DELETE_LOG,',
      '  JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), home: process.env.HERMES_HOME }) + "\\n"',
      ')'
    ].join('\n')
  )
  const discovery = acpModelCatalogDiscovery(HERMES_LAUNCH_SPEC, catalogContext(root))
  expect(discovery).toMatchObject({
    kind: 'probe',
    listsOnDemand: true,
    listingNamesConfiguredModel: false
  })

  let startedCwd = ''
  let deletedOverAcp = false
  const connect = (): AcpModelCatalogSessionConnection => ({
    initialize: async () => ({ protocolVersion: 1, agentCapabilities: {} }),
    start: async (options) => {
      startedCwd = options.cwd
      return {
        kind: 'new',
        sessionId: SESSION_ID,
        response: {
          sessionId: SESSION_ID,
          models: { currentModelId: 'openai:gpt-5', availableModels: MODELS }
        }
      }
    },
    setConfigOption: async () => ({ configOptions: [] }),
    deleteSession: async () => {
      deletedOverAcp = true
      return {}
    },
    close: async () => {}
  })
  const probe = createAcpModelCatalogProbe(HERMES_LAUNCH_SPEC, {
    resolveEnvironment: async () => ({
      PATH: process.env.PATH ?? '',
      ORCA_HERMES_DELETE_LOG: log
    }),
    resolveCommandSettings: () => ({
      agentCmdOverrides: { hermes: `"${process.execPath}" "${script}"` }
    }),
    probeVersion: async () => ({ version: '0.23.0' }),
    dataDirectory: root,
    homePath: home,
    connectSession: connect
  })
  const store = new AgentModelCatalogStore()
  const service = createAgentModelCatalogService({
    store,
    getRecord: () => undefined,
    getConversation: () => undefined,
    drivesRecord: () => true,
    resolveAccountHome: async () => ({ variable: 'HERMES_HOME', path: home }),
    hasChatRecords: () => true,
    listsOnDemand: new Set(['hermes']),
    probes: { hermes: probe }
  })
  onTestFinished(() => service.stop())

  await service.prewarm()
  expect(startedCwd).toBe('')
  const result = await service.read({
    agent: 'hermes',
    workspacePath: join(root, 'workspace'),
    waitForListing: true
  })
  expect(store.hasEntryForAgent('hermes')).toBe(true)
  if (result.origin === 'unknown') {
    throw new Error('Hermes listed no models')
  }
  expect(result.origin).toBe('probe')
  expect(result.models.map((model) => model.id)).toEqual([
    'openai:gpt-5',
    'anthropic:claude-sonnet'
  ])
  expect(startedCwd.startsWith(`${join(root, 'acp-listing-sessions', 'hermes')}${sep}`)).toBe(true)
  expect(deletedOverAcp).toBe(false)
  expect(JSON.parse((await readFile(log, 'utf8')).trim())).toEqual({
    argv: ['sessions', 'delete', '--yes', '--', SESSION_ID],
    cwd: await realpath(home),
    home
  })
})

it('treats ephemeral missing sessions as deleted, reports stdout errors, and rejects unsafe ids', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orca-hermes-discard-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const script = join(root, 'hermes-cli.mjs')
  const marker = join(root, 'ran')
  await writeFile(
    script,
    [
      "import { writeFileSync } from 'node:fs'",
      'const mode = process.env.ORCA_HERMES_TEST_MODE',
      'const id = process.argv.at(-1)',
      'writeFileSync(process.env.ORCA_HERMES_MARKER, `${id}:${process.env.ORCA_SCRUBBED ?? "unset"}`)',
      'if (mode === "missing") {',
      "  process.stdout.write(`No session '${id}'. Run: hermes sessions list to find the id.\\n`)",
      '  process.exit(1)',
      '}',
      'if (mode === "stdout-error") {',
      '  process.stdout.write("Cannot delete active session: busy\\n")',
      '  process.exit(1)',
      '}'
    ].join('\n')
  )
  const baseSession = {
    cwd: join(root, 'private'),
    launchCwd: root,
    accountHomePath: root,
    command: process.execPath,
    prefixArgs: [script],
    envToDelete: ['ORCA_SCRUBBED']
  }

  for (const unsafe of ['', 'short', '-flag-id', 'bad id value']) {
    await expect(
      discardHermesListingSession({ ...baseSession, sessionId: unsafe, env: {} })
    ).rejects.toThrow('refusing to delete unsafe Hermes listing session id')
  }

  await expect(
    discardHermesListingSession({
      ...baseSession,
      sessionId: SESSION_ID,
      env: {
        ORCA_HERMES_TEST_MODE: 'missing',
        ORCA_HERMES_MARKER: marker,
        ORCA_SCRUBBED: 'should-be-deleted'
      }
    })
  ).resolves.toBeUndefined()
  expect(await readFile(marker, 'utf8')).toBe(`${SESSION_ID}:unset`)

  await expect(
    discardHermesListingSession({
      ...baseSession,
      sessionId: SESSION_ID,
      env: {
        ORCA_HERMES_TEST_MODE: 'stdout-error',
        ORCA_HERMES_MARKER: marker
      }
    })
  ).rejects.toThrow('Cannot delete active session: busy')
})

function catalogContext(folder: string): StructuredAgentModelCatalogContext {
  return {
    environment: createStructuredAgentEnvironmentResolvers({
      resolveEnvironment: async () => ({ PATH: '/usr/bin' }),
      prewarm: false
    }),
    deps: {
      stateDirectory: folder,
      resolveWorkspacePath: async () => folder,
      resolveLaunchArgs: () => {
        throw new Error('unused')
      },
      resolveClaudeAuthPolicy: () => {
        throw new Error('unused')
      }
    }
  }
}
