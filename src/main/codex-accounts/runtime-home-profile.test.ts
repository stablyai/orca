import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { readFileSync, writeFileSync, rmSync, chmodSync } from 'node:fs'
import { createAgentProfileConnectionService } from '../agent-profiles/runtime-composition'
import { join } from 'node:path'
import { createSettings } from './runtime-home-settings-test-fixtures'
import {
  createCodexAuthJson,
  createManagedAuth,
  createStore,
  setupRuntimeHomeTest,
  teardownRuntimeHomeTest,
  testState
} from './runtime-home-service-test-harness'
vi.mock('electron', () => ({ app: { getPath: () => testState.userDataDir } }))
vi.mock('node:os', async (original) => ({
  ...(await original<object>()),
  homedir: () => testState.fakeHomeDir
}))
beforeEach(setupRuntimeHomeTest)
afterEach(teardownRuntimeHomeTest)

it('prepares independent A/B homes without changing selected C, shared auth, or credentials', async () => {
  writeFileSync(
    join(testState.fakeHomeDir, '.codex', 'config.toml'),
    'cli_auth_credentials_store = "file"\nmodel_provider = "openai"\nforced_login_method = "chatgpt"\n'
  )
  const accounts = ['a', 'b', 'c'].map((id) => ({
    id,
    email: `${id}@example.com`,
    managedHomePath: createManagedAuth(
      testState.userDataDir,
      id,
      createCodexAuthJson(`${id}@example.com`, id, id)
    ),
    providerAccountId: id,
    createdAt: 1,
    updatedAt: 1,
    lastAuthenticatedAt: 1
  }))
  for (const account of accounts) {
    const path = join(account.managedHomePath, 'auth.json')
    const auth = JSON.parse(readFileSync(path, 'utf8'))
    auth.tokens.access_token = 'synthetic'
    writeFileSync(path, JSON.stringify(auth))
  }
  const store = createStore(
    createSettings({
      agentLaunchProfiles: [],
      codexManagedAccounts: accounts,
      activeCodexManagedAccountId: 'c',
      activeCodexManagedAccountIdsByRuntime: { host: 'c', wsl: {} }
    })
  )
  const { CodexRuntimeHomeService } = await import('./runtime-home-service')
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Runtime home only consumes this fixture's settings store methods.
  const service = new CodexRuntimeHomeService(store as never)
  const before = accounts.map((a) => readFileSync(join(a.managedHomePath, 'auth.json'), 'utf8'))
  store.updateSettings.mockClear()
  const results = await Promise.all(
    ['a', 'b'].map((id) => service.prepareForCodexProfileLaunch(id))
  )
  expect(results).toEqual(accounts.slice(0, 2).map((a) => a.managedHomePath))
  expect(store.updateSettings).not.toHaveBeenCalled()
  expect(store.getSettings().activeCodexManagedAccountId).toBe('c')
  const executable = join(testState.userDataDir, 'canonical-agent')
  writeFileSync(executable, 'synthetic')
  chmodSync(executable, 0o700)
  const claude = { prepareForClaudeProfileLaunch: vi.fn() }
  const profiles = createAgentProfileConnectionService({
    store,
    claudeRuntimeAuth: claude,
    codexRuntimeHome: service,
    host: {
      hostId: 'local',
      platform: 'linux',
      isWsl: false,
      home: testState.fakeHomeDir,
      shell: '/bin/bash'
    },
    detectExecutable: async () => executable
  })
  const saved = await profiles.save({
    name: 'Codex A',
    connection: { agent: 'codex', source: { kind: 'managed', accountId: 'a' } }
  })
  const bound = await profiles.prepare(saved, { resume: false, mode: 'structured' })
  expect(bound.snapshot.identity.kind).toBe('verified')
  expect(bound.envPatch.CODEX_HOME).toBe(accounts[0].managedHomePath)
  expect(claude.prepareForClaudeProfileLaunch).not.toHaveBeenCalled()
  expect(store.getSettings().activeCodexManagedAccountId).toBe('c')
  store.updateSettings.mockClear()
  const refreshed = JSON.parse(before[0])
  refreshed.tokens.access_token = 'rotated-access'
  refreshed.tokens.refresh_token = 'rotated-refresh'
  writeFileSync(join(accounts[0].managedHomePath, 'auth.json'), JSON.stringify(refreshed))
  const resumed = await profiles.prepare(bound.snapshot, { resume: true, mode: 'structured' })
  expect(resumed.snapshot.identity).toEqual(bound.snapshot.identity)
  expect(readFileSync(join(accounts[0].managedHomePath, 'auth.json'), 'utf8')).toBe(
    JSON.stringify(refreshed)
  )
  resumed.release()
  const changed = JSON.parse(before[0])
  changed.tokens.account_id = 'changed'
  writeFileSync(join(accounts[0].managedHomePath, 'auth.json'), JSON.stringify(changed))
  await expect(
    profiles.prepare(bound.snapshot, { resume: true, mode: 'structured' })
  ).rejects.toThrow()
  writeFileSync(join(accounts[0].managedHomePath, 'auth.json'), before[0])
  bound.release()

  expect(Reflect.get(service, 'lastSyncedAccountId')).toBe('c')
  expect(accounts.map((a) => readFileSync(join(a.managedHomePath, 'auth.json'), 'utf8'))).toEqual(
    before
  )
  await expect(service.prepareForCodexProfileLaunch('missing')).rejects.toThrow()
  rmSync(join(accounts[0].managedHomePath, '.orca-managed-home'))
  await expect(service.prepareForCodexProfileLaunch('a')).rejects.toThrow()
  writeFileSync(join(accounts[1].managedHomePath, 'auth.json'), '{}')
  await expect(service.prepareForCodexProfileLaunch('b')).rejects.toThrow()
  expect(store.updateSettings).not.toHaveBeenCalled()
  store.updateSettings({ codexManagedAccounts: [{ ...accounts[2], managedHomeRuntime: 'wsl' }] })
  await expect(service.prepareForCodexProfileLaunch('c')).rejects.toThrow('local')
  await expect(
    profiles.preview({ agent: 'codex', source: { kind: 'managed', accountId: 'c' } })
  ).rejects.toThrow('inspection')
})

it.each([
  'model_provider = "custom"',
  'cli_auth_credentials_store = "keyring"',
  'cli_auth_credentials_store = "auto"',
  'cli_auth_credentials_store = "ephemeral"',
  '"cli_auth_credentials_store" = "keyring"',
  'forced_login_method = "api"',
  'forced_chatgpt_workspace_id = "other"',
  '"forced_chatgpt_workspace_id" = "other"',
  'forced_chatgpt_workspace_id = ["other"]',
  'forced_chatgpt_workspace_id = """\nother\n"""'
])('refuses changed global auth routing before touching the profile home: %s', async (config) => {
  const home = createManagedAuth(
    testState.userDataDir,
    'a',
    JSON.stringify({
      tokens: {
        access_token: 'synthetic',
        refresh_token: 'synthetic',
        id_token: `header.${Buffer.from(JSON.stringify({ email: 'a@example.com' })).toString('base64url')}.signature`,
        account_id: 'a'
      }
    })
  )
  const account = {
    id: 'a',
    email: 'a@example.com',
    managedHomePath: home,
    providerAccountId: 'a',
    createdAt: 1,
    updatedAt: 1,
    lastAuthenticatedAt: 1
  }
  const store = createStore(createSettings({ codexManagedAccounts: [account] }))
  const { CodexRuntimeHomeService } = await import('./runtime-home-service')
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Runtime home only consumes this fixture's settings store methods.
  const service = new CodexRuntimeHomeService(store as never)
  await service.prepareForCodexProfileLaunch('a')
  writeFileSync(join(home, 'config.toml'), 'model = "preserved"\n')
  const auth = readFileSync(join(home, 'auth.json'), 'utf8')
  const settings = store.getSettings()
  writeFileSync(join(testState.fakeHomeDir, '.codex', 'config.toml'), config)
  store.updateSettings.mockClear()
  await expect(service.prepareForCodexProfileLaunch('a')).rejects.toThrow()
  expect(readFileSync(join(home, 'config.toml'), 'utf8')).toBe('model = "preserved"\n')
  expect(readFileSync(join(home, 'auth.json'), 'utf8')).toBe(auth)
  expect(store.getSettings()).toEqual(settings)
  expect(store.updateSettings).not.toHaveBeenCalled()
})

it.each([
  ['personalAccessToken', 'personal_access_token'],
  ['bedrockApiKey', 'bedrock_api_key'],
  ['agentIdentity', 'agent_identity']
])(
  'refuses stale OAuth claims under active %s credentials in preview and preparation',
  async (mode, key) => {
    const stale = {
      tokens: {
        access_token: 'stale-access',
        refresh_token: 'stale-refresh',
        id_token: `header.${Buffer.from(JSON.stringify({ email: 'a@example.com' })).toString('base64url')}.signature`,
        account_id: 'a'
      }
    }
    const home = createManagedAuth(testState.userDataDir, 'a', JSON.stringify(stale))
    const account = {
      id: 'a',
      email: 'a@example.com',
      managedHomePath: home,
      providerAccountId: 'a',
      createdAt: 1,
      updatedAt: 1,
      lastAuthenticatedAt: 1
    }
    const store = createStore(
      createSettings({ codexManagedAccounts: [account], agentLaunchProfiles: [] })
    )
    const { CodexRuntimeHomeService } = await import('./runtime-home-service')
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Runtime home only consumes this fixture's settings store methods.
    const runtime = new CodexRuntimeHomeService(store as never)
    const executable = join(testState.userDataDir, 'synthetic-cli')
    writeFileSync(executable, 'synthetic')
    chmodSync(executable, 0o700)
    const profiles = createAgentProfileConnectionService({
      store,
      codexRuntimeHome: runtime,
      claudeRuntimeAuth: { prepareForClaudeProfileLaunch: vi.fn() },
      host: {
        hostId: 'local',
        platform: 'linux',
        isWsl: false,
        home: testState.fakeHomeDir,
        shell: '/bin/bash'
      },
      detectExecutable: async () => executable
    })
    const profile = await profiles.save({
      name: 'A',
      connection: { agent: 'codex', source: { kind: 'managed', accountId: 'a' } }
    })
    writeFileSync(
      join(home, 'auth.json'),
      JSON.stringify({
        ...stale,
        auth_mode: mode,
        [key]:
          key === 'bedrock_api_key' ? { api_key: 'different-credential' } : 'different-credential'
      })
    )
    await Promise.all([
      expect(
        profiles.preview({ agent: 'codex', source: { kind: 'managed', accountId: 'a' } })
      ).rejects.toThrow(),
      expect(profiles.prepare(profile, { mode: 'structured', resume: false })).rejects.toThrow(),
      expect(runtime.prepareForCodexProfileLaunch('a')).rejects.toThrow()
    ])
  }
)
