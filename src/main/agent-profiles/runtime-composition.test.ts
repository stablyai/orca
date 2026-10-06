import { claudeProviderHandle } from '../../shared/agent-session-provider-handle-encoding'
import { prepareTerminalProfileLaunch } from '../ipc/pty/host-env/agent-profile-launch'
import { enrollIsolatedClaudeAccount } from '../claude-accounts/isolated-account-auth'
import { createClaudeStructuredLaunchResolver } from '../claude/claude-structured-launch-resolution'
import { agentSessionRecordFixture } from '../../shared/agent-session-record.test-fixture'
import { installFakeAppEnvironment } from '../../../config/scripts/vitest-host-ports-setup'
import {
  unlinkSync,
  readFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  chmodSync
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createAgentProfileConnectionService } from './runtime-composition'
import { createSettings, createStore } from '../codex-accounts/service-test-harness'
import { hasClaudeCredentialOwners } from '../claude-accounts/live-pty-gate'
import type { ClaudeManagedAccount } from '../../shared/managed-account-types'
const state = vi.hoisted(() => ({ root: '' }))
vi.mock('electron', () => ({ app: { getPath: () => state.root } }))
vi.mock('../claude-accounts/keychain', () => ({
  readActiveClaudeKeychainCredentialsStrict: async (home: string) =>
    readFileSync(join(home, '.credentials.json'), 'utf8')
}))
let executable: string
let accounts: ClaudeManagedAccount[]
beforeEach(() => {
  installFakeAppEnvironment({ getPath: () => state.root })
  state.root = mkdtempSync(join(tmpdir(), 'profile-composition-'))
  executable = join(state.root, 'canonical cli')
  writeFileSync(executable, 'fixture')
  chmodSync(executable, 0o700)
  accounts = ['a', 'b'].map((id) => {
    const managedAuthPath = join(state.root, 'claude-accounts', id, 'auth')
    mkdirSync(managedAuthPath, { recursive: true })
    writeFileSync(join(managedAuthPath, '.orca-managed-claude-auth'), id)
    writeFileSync(join(managedAuthPath, '.orca-claude-isolated-auth'), '1\n')
    writeFileSync(
      join(managedAuthPath, '.credentials.json'),
      JSON.stringify({ claudeAiOauth: { accessToken: 'synthetic', email: `${id}@example.com` } })
    )
    writeFileSync(
      join(managedAuthPath, '.claude.json'),
      JSON.stringify({ oauthAccount: { emailAddress: `${id}@example.com`, organizationUuid: id } })
    )
    return {
      id,
      email: `${id}@example.com`,
      managedAuthPath,
      authMethod: 'subscription-oauth',
      organizationUuid: id,
      createdAt: 1,
      updatedAt: 1,
      lastAuthenticatedAt: 1
    }
  })
})
afterEach(() => {
  vi.restoreAllMocks()
  rmSync(state.root, { recursive: true, force: true })
})
function fixture() {
  const store = createStore(
    createSettings({
      claudeManagedAccounts: accounts,
      activeClaudeManagedAccountId: 'b',
      agentLaunchProfiles: []
    })
  )
  const prepareForClaudeProfileLaunch = vi.fn(async (id: string) => ({
    configDir: accounts.find((a) => a.id === id)!.managedAuthPath,
    runtime: 'host' as const,
    wslDistro: null,
    wslLinuxConfigDir: null,
    envPatch: {},
    stripAuthEnv: true,
    isolatedCredentials: true,
    provenance: `managed:${id}` as const
  }))
  const codex = {
    prepareForCodexProfileLaunch: vi.fn(),
    resolveCodexManagedAccountHomeForInactiveFetch: vi.fn()
  }
  const service = createAgentProfileConnectionService({
    store,
    claudeRuntimeAuth: { prepareForClaudeProfileLaunch },
    codexRuntimeHome: codex,
    host: {
      hostId: 'local',
      platform: 'linux',
      isWsl: false,
      home: state.root,
      shell: '/bin/bash'
    },
    detectExecutable: async () => executable
  })
  return { service, store, prepareForClaudeProfileLaunch, codex }
}
it('composes two independent Claude profiles with credential leases and managed OAuth routing', async () => {
  const { service, store } = fixture()
  const profiles = await Promise.all(
    ['a', 'b'].map((accountId) =>
      service.save({
        name: accountId,
        connection: { agent: 'claude', source: { kind: 'managed', accountId } }
      })
    )
  )
  const prepared = await Promise.all(
    profiles.map((profile) => service.prepare(profile, { mode: 'terminal', resume: false }))
  )
  try {
    expect(store.getSettings().agentLaunchProfiles).toHaveLength(2)
    expect(store.getSettings().activeClaudeManagedAccountId).toBe('b')
    expect(prepared.map((p) => p.snapshot.resolvedHome)).toEqual(
      accounts.map((a) => a.managedAuthPath)
    )
    expect(prepared[0].envToDelete).toContain('CLAUDE_CODE_USE_BEDROCK')
    expect(hasClaudeCredentialOwners()).toBe(true)
    store.updateSettings({
      claudeManagedAccounts: accounts.map((a) => ({ ...a, organizationUuid: 'changed' }))
    })
    await expect(
      service.prepare(prepared[0].snapshot, { mode: 'terminal', resume: true })
    ).rejects.toThrow('identity')
  } finally {
    prepared.forEach((p) => p.release())
  }
  expect(hasClaudeCredentialOwners()).toBe(false)
})
it('releases failed Claude preparation and refuses missing, WSL and untrusted references', async () => {
  const { service, prepareForClaudeProfileLaunch, store } = fixture()
  const profile = await service.save({
    name: 'a',
    connection: { agent: 'claude', source: { kind: 'managed', accountId: 'a' } }
  })
  prepareForClaudeProfileLaunch.mockRejectedValueOnce(new Error('fixture failure'))
  await expect(service.prepare(profile, { mode: 'terminal', resume: false })).rejects.toThrow(
    'preparation'
  )
  expect(hasClaudeCredentialOwners()).toBe(false)
  for (const account of [
    undefined,
    { ...accounts[0], managedAuthRuntime: 'wsl' as const },
    { ...accounts[0], managedAuthPath: state.root }
  ]) {
    store.updateSettings({ claudeManagedAccounts: account ? [account] : [] })
    await expect(
      service.preview({ agent: 'claude', source: { kind: 'managed', accountId: 'a' } })
    ).rejects.toThrow('inspection')
  }
})
it('leaves unknown managed identity unverified and external homes untouched', async () => {
  const { service, store, prepareForClaudeProfileLaunch, codex } = fixture()
  store.updateSettings({ claudeManagedAccounts: [{ ...accounts[0], authMethod: 'unknown' }] })
  expect(
    (await service.preview({ agent: 'claude', source: { kind: 'managed', accountId: 'a' } }))
      .identity.kind
  ).toBe('unverified')
  const profile = await service.save({
    name: 'external',
    connection: { agent: 'claude', source: { kind: 'home', value: state.root } }
  })
  const prepared = await service.prepare(profile, { mode: 'terminal', resume: false })
  expect(prepared.envToDelete).toEqual([])
  expect(prepareForClaudeProfileLaunch).not.toHaveBeenCalled()
  expect(codex.prepareForCodexProfileLaunch).not.toHaveBeenCalled()
  expect(codex.resolveCodexManagedAccountHomeForInactiveFetch).not.toHaveBeenCalled()
})

it('refuses canonical login drift with an unchanged account row and preserves same-account rotation', async () => {
  const { service, store } = fixture()
  const profile = await service.save({
    name: 'A',
    connection: { agent: 'claude', source: { kind: 'managed', accountId: 'a' } }
  })
  const original = await service.prepare(profile, { mode: 'terminal', resume: false })
  original.release()
  const home = accounts[0].managedAuthPath
  const rotated = JSON.stringify({
    claudeAiOauth: { accessToken: 'rotated', refreshToken: 'rotated-refresh' }
  })
  writeFileSync(join(home, '.credentials.json'), rotated)
  const refreshed = await service.prepare(original.snapshot, { mode: 'structured', resume: true })
  refreshed.release()
  expect(readFileSync(join(home, '.credentials.json'), 'utf8')).toBe(rotated)
  writeFileSync(
    join(home, '.credentials.json'),
    JSON.stringify({ claudeAiOauth: { accessToken: 'other-login', email: 'b@example.com' } })
  )
  writeFileSync(
    join(home, '.claude.json'),
    JSON.stringify({ oauthAccount: { emailAddress: 'b@example.com', organizationUuid: 'b' } })
  )
  expect(store.getSettings().claudeManagedAccounts[0].email).toBe('a@example.com')
  await expect(
    service.preview({ agent: 'claude', source: { kind: 'managed', accountId: 'a' } })
  ).rejects.toThrow()
  await expect(service.prepare(profile, { mode: 'terminal', resume: false })).rejects.toThrow()
  await expect(
    service.prepare(original.snapshot, { mode: 'structured', resume: true })
  ).rejects.toThrow()
  expect(hasClaudeCredentialOwners()).toBe(false)
})
it.each(['settings.json', 'settings.local.json'])(
  'refuses pre-existing workspace authority in %s',
  async (file) => {
    const { service } = fixture()
    const profile = await service.save({
      name: 'A',
      connection: { agent: 'claude', source: { kind: 'managed', accountId: 'a' } }
    })
    const prepared = await service.prepare(profile, { mode: 'terminal', resume: false })
    mkdirSync(join(state.root, '.claude'))
    writeFileSync(
      join(state.root, '.claude', file),
      JSON.stringify({
        env: { ANTHROPIC_AUTH_TOKEN: 'synthetic', ANTHROPIC_BASE_URL: 'https://example.invalid' }
      })
    )
    try {
      await expect(service.validateLaunch(prepared, { cwd: state.root, env: {} })).rejects.toThrow()
    } finally {
      prepared.release()
    }
  }
)

it('checks the newly discovered managed terminal CLI after enrollment and leaves external discovery unprobed', async () => {
  const { service } = fixture()
  const home = accounts[0].managedAuthPath
  unlinkSync(join(home, '.orca-claude-isolated-auth'))
  await enrollIsolatedClaudeAccount(
    { accountId: 'a', managedAuthPath: home },
    { oauthAccount: { emailAddress: 'a@example.com', organizationUuid: 'a' } }
  )
  const profile = await service.save({
    name: 'A',
    connection: { agent: 'claude', source: { kind: 'managed', accountId: 'a' } }
  })
  vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
  writeFileSync(executable, '#!/bin/sh\nprintf "2.1.280 (Claude Code)\\n"\n')
  const prepared = await prepareTerminalProfileLaunch(
    { agentProfileId: profile.id, command: 'claude' },
    { service, reattach: false, resume: false, isWsl: false, cwd: state.root }
  )
  prepared!.release()
  const saved = prepared!.snapshot
  executable = join(state.root, 'downgraded-cli')
  writeFileSync(executable, '#!/bin/sh\nprintf "2.0.76 (Claude Code)\\n"\n', { mode: 0o700 })
  await expect(
    prepareTerminalProfileLaunch(
      { launchConfig: { agentArgs: '', agentEnv: {}, agentProfile: saved }, command: 'claude' },
      { service, reattach: false, resume: true, isWsl: false, cwd: state.root }
    )
  ).rejects.toThrow('2.1 or later')
  expect(hasClaudeCredentialOwners()).toBe(false)
  const external = await service.save({
    name: 'external',
    connection: { agent: 'claude', source: { kind: 'home', value: state.root } }
  })
  const launched = await prepareTerminalProfileLaunch(
    { agentProfileId: external.id, command: 'claude' },
    { service, reattach: false, resume: false, isWsl: false, cwd: state.root }
  )
  expect(launched!.snapshot.executable).toBe(executable)
  launched!.release()
})
it('checks effective authority at structured acquisition and releases its lease on refusal', async () => {
  const { service } = fixture()
  const profile = await service.save({
    name: 'A',
    connection: { agent: 'claude', source: { kind: 'managed', accountId: 'a' } }
  })
  const snapshot = await service.resolveSnapshot(profile, { mode: 'structured', resume: false })
  const record = agentSessionRecordFixture()
  record.accountHome = {
    variable: 'CLAUDE_CONFIG_DIR',
    path: snapshot.resolvedHome,
    agentProfile: snapshot
  }
  const resolve = createClaudeStructuredLaunchResolver({
    agentProfiles: service,
    store: { getRecord: () => record },
    resolveWorkspacePath: async () => state.root,
    resolveAuthPolicy: () => ({ stripAuthEnv: true }),
    hasTranscript: async () => false
  })
  const identity = {
    sessionId: record.sessionId,
    workspaceId: record.location.workspaceId,
    hostId: 'local',
    agent: 'claude' as const,
    providerHandle: claudeProviderHandle('provider-session-alpha-1', null)
  }
  const launch = await resolve({ identity })
  launch.release!()
  writeFileSync(
    join(snapshot.resolvedHome, 'settings.json'),
    JSON.stringify({ apiKeyHelper: 'echo synthetic' })
  )
  await expect(resolve({ identity })).rejects.toThrow('direct Claude OAuth')
  expect(hasClaudeCredentialOwners()).toBe(false)
})

it.each(['missing identity', 'missing credential', 'credential-only drift'])(
  'refuses %s in canonical managed state',
  async (change) => {
    const { service } = fixture()
    const profile = await service.save({
      name: 'A',
      connection: { agent: 'claude', source: { kind: 'managed', accountId: 'a' } }
    })
    const home = accounts[0].managedAuthPath
    if (change === 'missing identity') {
      unlinkSync(join(home, '.claude.json'))
    } else if (change === 'missing credential') {
      unlinkSync(join(home, '.credentials.json'))
    } else {
      writeFileSync(
        join(home, '.credentials.json'),
        JSON.stringify({ claudeAiOauth: { accessToken: 'other-login', email: 'b@example.com' } })
      )
    }
    await expect(service.prepare(profile, { mode: 'terminal', resume: false })).rejects.toThrow(
      'canonical Claude login'
    )
    expect(hasClaudeCredentialOwners()).toBe(false)
  }
)
