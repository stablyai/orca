import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAcpModelCatalogProbe } from '../acp/discovery/acp-model-catalog-probe'
import { agentModelCatalogFingerprint } from '../native-chat/agent-model-catalog/agent-model-catalog-fingerprint'
import {
  AgentModelCatalogProbeError,
  type AgentModelCatalogListingLaunch,
  type runAgentModelCatalogListing
} from '../native-chat/agent-model-catalog/agent-model-catalog-probe-runner'
import { createAgentModelCatalogService } from '../native-chat/agent-model-catalog/agent-model-catalog-service'
import {
  AgentModelCatalogStore,
  agentModelCatalogStore
} from '../native-chat/agent-model-catalog/agent-model-catalog-store'
import { AgentModelCatalogUnavailableError } from '../native-chat/agent-model-catalog/agent-model-catalog-unavailable'
import { createStructuredAgentEnvironmentResolvers } from '../runtime/agent-session/environment/structured-agent-shell-environment'
import { structuredAgentRuntimeMetadata } from '../runtime/agent-session/installation/structured-agent-runtime-metadata'
import { acpModelCatalogDiscovery } from '../runtime/agent-session/model-catalog/structured-agent-model-catalog-discovery'
import { ANTIGRAVITY_LAUNCH_SPEC } from './antigravity-acp-launch-spec'
import { antigravityHostAccountHome, expireAntigravityHostAcpChecks } from './antigravity-host-acp'
import { credential, harness } from './native-account-test-fixtures'

vi.mock('./native-credential-backend', () => ({
  createAntigravityHostCredentialBackend: () => ({
    read: async () => ({ contents: '{}' }),
    write: async () => {}
  }),
  isAntigravityFileStorageHost: () => false
}))
vi.mock('./native-macos-credentials', () => ({
  hasAntigravityMacOSCredential: async () => true
}))

const folders: string[] = []
afterEach(async () => {
  expireAntigravityHostAcpChecks()
  agentModelCatalogStore.expireAgent('antigravity')
  vi.unstubAllEnvs()
  await Promise.all(folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true })))
})

async function createTempFolder(prefix: string): Promise<string> {
  const folder = await mkdtemp(join(tmpdir(), prefix))
  folders.push(folder)
  return folder
}

describe('Antigravity host CLI model discovery', () => {
  it('discovers models through host agy while skipping probing for managed accounts', async () => {
    const stateDirectory = await createTempFolder('orca-agy-probe-state-')
    const home = await createTempFolder('orca-agy-probe-home-')
    const localBin = join(home, '.local', 'bin')
    await mkdir(localBin, { recursive: true })
    const agyBinary = join(localBin, process.platform === 'win32' ? 'agy.cmd' : 'agy')
    await writeFile(agyBinary, '', { mode: 0o755 })

    const deps = {
      stateDirectory,
      resolveWorkspacePath: async () => home,
      resolveLaunchArgs: () => [],
      resolveClaudeAuthPolicy: () => ({ account: 'system' as const }),
      resolveEnvironment: async () => ({
        HOME: home,
        PATH: '',
        GEMINI_API_KEY: 'secret-gemini-key',
        GOOGLE_API_KEY: 'secret-google-key'
      })
    }
    const discovery = acpModelCatalogDiscovery(ANTIGRAVITY_LAUNCH_SPEC, {
      deps,
      environment: createStructuredAgentEnvironmentResolvers(deps)
    })
    expect(discovery).toMatchObject({
      kind: 'probe',
      listingNamesConfiguredModel: false
    })
    if (discovery.kind !== 'probe') {
      throw new Error('expected probe discovery')
    }
    expect(discovery.listsInChatFolder).toBeUndefined()

    let capturedLaunch: AgentModelCatalogListingLaunch | undefined
    let releaseVersion = '1.5.4'
    const runListing: typeof runAgentModelCatalogListing = async (launch) => {
      capturedLaunch = launch
      return [
        'gemini-4-carbon-medium\tGemini 4 Carbon (Medium)',
        'gemini-4-carbon-high\tGemini 4 Carbon (High)',
        'gemini-4-carbon-low\tGemini 4 Carbon (Low)',
        'gpt-oss-120b-medium\tGPT-OSS 120B (Medium)'
      ].join('\n')
    }
    const probe = createAcpModelCatalogProbe(ANTIGRAVITY_LAUNCH_SPEC, {
      dataDirectory: stateDirectory,
      homePath: home,
      resolveEnvironment: async () => ({
        HOME: home,
        USERPROFILE: home,
        PATH: '',
        GEMINI_API_KEY: 'secret-gemini-key',
        GOOGLE_API_KEY: 'secret-google-key'
      }),
      probeVersion: async () => ({ version: releaseVersion }),
      runListing
    })

    const hostAccount = antigravityHostAccountHome(home)
    const managedAccount = await ANTIGRAVITY_LAUNCH_SPEC.account.resolve({
      launchEnv: { HOME: home },
      stateDirectory
    })
    expect(probe.supportsAccount?.(hostAccount)).toBe(true)
    expect(probe.supportsAccount?.(managedAccount)).toBe(false)

    const expectedModels = [
      {
        id: 'gemini-4-carbon',
        label: 'Gemini 4 Carbon',
        isDefault: false,
        efforts: [
          { value: 'low', label: 'Low' },
          { value: 'medium', label: 'Medium' },
          { value: 'high', label: 'High' }
        ]
      },
      {
        id: 'gpt-oss-120b-medium',
        label: 'GPT-OSS 120B (Medium)',
        isDefault: false,
        efforts: []
      }
    ]
    await expect(probe(hostAccount, {})).resolves.toEqual({
      origin: 'probe',
      models: expectedModels
    })
    expect(capturedLaunch?.command).toBe(agyBinary)
    expect(capturedLaunch?.args).toEqual(['models'])
    expect(capturedLaunch?.env?.GEMINI_API_KEY).toBeUndefined()
    expect(capturedLaunch?.env?.GOOGLE_API_KEY).toBeUndefined()
    expect(capturedLaunch?.envToDelete).toEqual(['GEMINI_API_KEY', 'GOOGLE_API_KEY'])

    releaseVersion = '1.5.1'
    await expect(probe(hostAccount, {})).rejects.toThrow('does not run structured chats')

    releaseVersion = '1.5.4'
    const store = new AgentModelCatalogStore()
    let resolveAccount = async () => managedAccount
    const service = createAgentModelCatalogService({
      store,
      probes: { antigravity: probe },
      resolveAccountHome: () => resolveAccount(),
      getConversation: () => undefined,
      getRecord: () => undefined,
      drivesRecord: () => true,
      recordWorkspacePath: async () => null
    })
    try {
      const managedFingerprint = agentModelCatalogFingerprint({
        agent: 'antigravity',
        accountHome: managedAccount,
        wslDistro: null
      })
      await expect(
        service.read({ agent: 'antigravity', waitForListing: true })
      ).resolves.toStrictEqual({ origin: 'unknown' })
      expect(store.hasActiveFailure(managedFingerprint)).toBe(false)

      const pendingAccount = Promise.withResolvers<typeof hostAccount>()
      resolveAccount = () => pendingAccount.promise
      const switching = service.demand({ agent: 'antigravity' })
      expect(service.snapshot({ agent: 'antigravity' })).toStrictEqual({ origin: 'unknown' })
      pendingAccount.resolve(hostAccount)
      await switching

      await expect(service.read({ agent: 'antigravity', waitForListing: true })).resolves.toEqual({
        origin: 'probe',
        listingNamesConfiguredModel: false,
        fetchedAt: expect.any(Number),
        models: expectedModels
      })
    } finally {
      await service.stop()
    }
  })

  it('maps signed-out host `agy models` outputs and timeouts to system notSignedIn while leaving non-auth failures plain', async () => {
    const stateDirectory = await createTempFolder('orca-agy-auth-state-')
    const home = await createTempFolder('orca-agy-auth-home-')
    const localBin = join(home, '.local', 'bin')
    await mkdir(localBin, { recursive: true })
    await writeFile(join(localBin, process.platform === 'win32' ? 'agy.cmd' : 'agy'), '', {
      mode: 0o755
    })

    let nextListing: () => Promise<string> = async () => ''
    const probe = createAcpModelCatalogProbe(ANTIGRAVITY_LAUNCH_SPEC, {
      dataDirectory: stateDirectory,
      homePath: home,
      resolveEnvironment: async () => ({ HOME: home, USERPROFILE: home, PATH: '' }),
      probeVersion: async () => ({ version: '1.5.4' }),
      runListing: () => nextListing()
    })
    const hostAccount = antigravityHostAccountHome(home)
    const systemNotSignedIn = new AgentModelCatalogUnavailableError({
      reason: 'notSignedIn',
      account: 'system'
    })

    nextListing = async () => {
      throw new AgentModelCatalogProbeError('agy exited 1', 'exit', false, {
        exitCode: 1,
        stdout: '',
        stderr:
          'Fetching available models...\nError: Please sign in to view available models. Launch the CLI without arguments to sign in.\n'
      })
    }
    await expect(probe(hostAccount, {})).rejects.toEqual(systemNotSignedIn)

    nextListing = async () => {
      throw new AgentModelCatalogProbeError('agy exited 1', 'exit', false, {
        exitCode: 1,
        stdout: 'AGY_ERROR: {"status":"UNAUTHENTICATED","error_code":401}\n',
        stderr: ''
      })
    }
    await expect(probe(hostAccount, {})).rejects.toEqual(systemNotSignedIn)

    nextListing = async () => {
      throw new AgentModelCatalogProbeError(
        'agy did not list models within 15000ms',
        'timeout',
        false,
        {
          exitCode: null,
          stdout: '',
          stderr:
            'Authentication required. Please visit the URL: https://accounts.google.com/o/oauth2'
        }
      )
    }
    await expect(probe(hostAccount, {})).rejects.toEqual(systemNotSignedIn)

    nextListing = async () => 'Not logged in. Run agy login.\n'
    await expect(probe(hostAccount, {})).rejects.toEqual(systemNotSignedIn)

    nextListing = async () => {
      throw new AgentModelCatalogProbeError('agy exited 1', 'exit', false, {
        exitCode: 1,
        stdout:
          'AGY_ERROR: {"status":"RESOURCE_EXHAUSTED","error_code":429,"message":"authentication quota"}\n',
        stderr: ''
      })
    }
    const rateLimited = await probe(hostAccount, {}).catch((error: unknown) => error)
    expect(rateLimited).toBeInstanceOf(AgentModelCatalogProbeError)
    expect(rateLimited).not.toBeInstanceOf(AgentModelCatalogUnavailableError)
  })

  it.skipIf(process.platform === 'win32')(
    'resolves the host agy account for catalog reads and chat launches while keeping identity reads managed',
    async () => {
      vi.stubEnv('ELECTRON_RUN_AS_NODE', '1')
      const stateDirectory = await createTempFolder('orca-agy-key-state-')
      const home = await createTempFolder('orca-agy-key-home-')
      const bin = await createTempFolder('orca-agy-key-bin-')
      const agy = join(bin, 'agy')
      const initialized = {
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: true,
          sessionCapabilities: { resume: {}, close: {}, load: {}, list: {} },
          auth: { logout: {} }
        },
        agentInfo: { name: 'Antigravity ACP Server', version: '1.5.4' },
        authMethods: [{ id: 'oauth-personal', name: 'Log in with Google' }]
      }
      await writeFile(
        agy,
        `#!${process.execPath}
if (process.argv[2] !== 'acp') process.exit(2)
require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
  const { id, method } = JSON.parse(line)
  const reply =
    method === 'initialize'
      ? { result: ${JSON.stringify(initialized)} }
      : method === 'session/list'
        ? { result: { sessions: [] } }
        : null
  if (reply) process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, ...reply }) + '\\n')
})
`
      )
      await chmod(agy, 0o755)

      const metadata = structuredAgentRuntimeMetadata('antigravity')!
      const services = {
        getClaudeConfigDirectory: () => null,
        prepareCodexLaunchHome: async () => home,
        readCodexLaunchHome: async () => home,
        workspaceTrustSettings: () => ({}),
        workspaceTrustRepoDecision: () => undefined,
        stateDirectory,
        hostLaunchEnvironment: async () => ({ PATH: bin, HOME: home }),
        hostSettings: () => ({})
      }
      const readHome = await metadata.resolveAccountHome(
        { launchEnv: { HOME: home }, location: null, purpose: 'read', workspacePath: null },
        services
      )
      const launchHome = await metadata.resolveAccountHome(
        { launchEnv: { HOME: home }, location: null, purpose: 'launch', workspacePath: null },
        services
      )
      const identityHome = await metadata.resolveAccountHome(
        { launchEnv: { HOME: home }, location: null, purpose: 'identity', workspacePath: null },
        services
      )

      expect(readHome).toEqual(antigravityHostAccountHome(home))
      expect(launchHome).toEqual(antigravityHostAccountHome(home))
      expect(identityHome).toEqual({
        variable: 'GEMINI_HOME',
        path: join(stateDirectory, 'antigravity-chat')
      })
    }
  )

  it('retires only the host agy catalog scope when switching native accounts, preserving Orca Chat models', async () => {
    const home = await createTempFolder('orca-agy-switch-home-')
    const stateDirectory = await createTempFolder('orca-agy-switch-state-')
    const hostFingerprint = agentModelCatalogFingerprint({
      agent: 'antigravity',
      accountHome: antigravityHostAccountHome(home),
      wslDistro: null
    })
    const managedFingerprint = agentModelCatalogFingerprint({
      agent: 'antigravity',
      accountHome: { variable: 'GEMINI_HOME', path: join(stateDirectory, 'antigravity-chat') },
      wslDistro: null
    })
    const h = harness(credential('acct-a', 1), home)
    const acctA = (await h.service.addCurrentAccount()).activeAccountId!
    h.setNative(credential('acct-b', 2))
    const acctB = (await h.service.addCurrentAccount()).activeAccountId!
    await h.service.selectAccount(acctB)

    agentModelCatalogStore.recordSuccess(
      hostFingerprint,
      'antigravity',
      {
        origin: 'probe',
        models: [{ id: 'gemini-4-carbon', label: 'Gemini 4 Carbon', isDefault: false, efforts: [] }]
      },
      'discovery'
    )
    agentModelCatalogStore.recordSuccess(
      managedFingerprint,
      'antigravity',
      {
        origin: 'live-session',
        models: [
          { id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash', isDefault: false, efforts: [] }
        ]
      },
      'live'
    )

    await h.service.selectAccount(acctB)
    expect(agentModelCatalogStore.observation(hostFingerprint)?.models[0]?.id).toBe(
      'gemini-4-carbon'
    )

    await h.service.selectAccount(acctA)
    expect(agentModelCatalogStore.observation(hostFingerprint)).toBeNull()
    expect(agentModelCatalogStore.observation(managedFingerprint)?.models[0]?.id).toBe(
      'gemini-3.8-flash'
    )
  })
})
