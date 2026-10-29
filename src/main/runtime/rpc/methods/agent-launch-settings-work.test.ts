import '../unused-default-rpc-methods.test-fixture'
import { afterEach, expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../dispatcher'
import type { RpcRequest } from '../core'
import { OrcaRuntimeService } from '../../orca-runtime'
import type { RuntimeStore } from '../../runtime-store-contract'
import { RuntimeRpcPairing } from '../../runtime-rpc/runtime-rpc-pairing'
import { REPO_METHODS } from './repo'
import { AGENT_HOOK_METHODS } from './agent-hooks'
import { CLIENT_UI_METHODS } from './client-ui'
import { WORKTREE_VISIBILITY_DEFAULTS_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import * as updatesModule from '../../../../shared/agent-launch-permission-updates'
import * as launchProfile from '../../../../shared/tui-agent-launch-defaults'
import * as shell from '../../../../shared/tui-agent-startup-shell'
import {
  measureSettingsWork,
  expectSettingsWorkScale,
  createGlobalSettingsFixture
} from '../../../../shared/global-settings-test-fixture'
import { partialRuntimeStore } from '../../runtime-store-partial-fixture'

vi.mock('../../../codex/managed-wsl-home-shell-preflight', () => ({
  prepareManagedWslCodexHomeBeforeShellLaunch: async ({
    hooksEnabled
  }: {
    hooksEnabled: boolean
  }) => (hooksEnabled ? { agent: 'codex', state: 'installed' } : null)
}))
vi.mock('../../../../shared/sidebar-inputs-switch', () => ({ ORCA_SIDEBAR_INPUTS_IS_MAIN: true }))
vi.mock('../../../claude/agent-view-service', () => ({
  getClaudeAgentViewService: () => ({ reconcile: async () => {} })
}))
afterEach(() => vi.restoreAllMocks())

function makeRequest(method: string, params?: unknown): RpcRequest {
  return { id: 'req-1', authToken: 'tok', method, params }
}

it.each([20, 200])('projects %s repos without launch work', async (n) => {
  const settings = createGlobalSettingsFixture({
    hostSettingOverrides: { 'runtime:alpha': { displayLabel: '  Label  ' } },
    worktreeVisibilityDefaults: { external: 'show' },
    agentPermissionDefault: 'ask',
    agentDefaultArgs: { claude: '--model opus '.repeat(n) },
    agentDefaultEnv: {
      claude: Object.fromEntries(Array.from({ length: n }, (_, i) => [`K${i}`, 'private']))
    }
  })
  const ingressReceipts: ReturnType<typeof measureSettingsWork>['work'][] = []
  const legacy = updatesModule.legacyLaunchTextUpdates
  vi.spyOn(updatesModule, 'legacyLaunchTextUpdates').mockImplementation((...args) => {
    const receipt = measureSettingsWork(() => legacy(...args))
    ingressReceipts.push(receipt.work)
    return receipt.value
  })
  const composed = vi.spyOn(launchProfile, 'composeAgentLaunchProfile')
  const tokenized = vi.spyOn(shell, 'tokenizeStartupCommand')
  const store: Pick<RuntimeStore, 'getSettings' | 'updateSettings' | 'runDurableMutation'> = {
    getSettings: () => settings,
    updateSettings: (updates) => Object.assign(settings, updates),
    runDurableMutation: async (mutate) => mutate().value
  }
  const host = new OrcaRuntimeService(partialRuntimeStore(store))
  vi.spyOn(host, 'configureNotificationDismissalStore').mockImplementation(() => {})
  vi.spyOn(host.pairedServerRows!, 'attach').mockReturnValue(() => {})
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: invoking captured label callbacks; only relay retirement subscribes, no transport is used.
  const relayHosts = { onEnvironmentRetired: () => () => {} } as unknown as NonNullable<
    Parameters<RuntimeRpcPairing['setMobileDesktopRelayHosts']>[0]
  >
  const labels = new RuntimeRpcPairing({
    runtime: host,
    userDataPath: '/unused/pr31315',
    methods: []
  })
  labels.setMobileDesktopRelayHosts(relayHosts)
  expect(host.pairedServerRows?.['options'].hostLabelOverrides().get('runtime:alpha')).toBe('Label')
  expect(
    labels['mobileRelayHostCatalog']?.['options'].hostLabelOverrides().get('runtime:alpha')
  ).toBe('Label')
  labels.setMobileDesktopRelayHosts(null)
  vi.spyOn(host, 'enrichMissingRepoGitRemoteIdentities').mockResolvedValue(undefined)
  vi.spyOn(host, 'listVisibleRepos').mockReturnValue(
    Array.from({ length: n }, (_, i) => ({
      id: `repo-${i}`,
      path: '/repo',
      displayName: `Repo ${i}`,
      badgeColor: 'gray',
      addedAt: 0,
      externalWorktreeVisibilityLegacy: false
    }))
  )
  const dispatcher = new RpcDispatcher({
    runtime: host,
    methods: [...REPO_METHODS, ...CLIENT_UI_METHODS, ...AGENT_HOOK_METHODS]
  })
  const legacyReplies: string[] = []
  const currentReplies: string[] = []

  await dispatcher.dispatchStreaming(makeRequest('repo.list'), (reply) => legacyReplies.push(reply))
  await dispatcher.dispatchStreaming(
    makeRequest('repo.list'),
    (reply) => currentReplies.push(reply),
    { clientCapabilities: [WORKTREE_VISIBILITY_DEFAULTS_RUNTIME_CAPABILITY] }
  )

  expect(JSON.parse(legacyReplies[0]!).result.repos).toHaveLength(n)
  expect(JSON.parse(legacyReplies[0]!).result.repos[0].externalWorktreeVisibility).toBe('show')
  delete settings.worktreeVisibilityDefaults
  legacyReplies.length = 0
  await dispatcher.dispatchStreaming(makeRequest('repo.list'), (reply) => legacyReplies.push(reply))
  expect(
    JSON.parse(legacyReplies[0]!).result.repos.map(
      (repo: { externalWorktreeVisibility: string }) => repo.externalWorktreeVisibility
    )
  ).toEqual(Array(n).fill('hide'))
  settings.agentStatusHooksEnabled = true
  settings.disabledTuiAgents = []
  expect(
    await dispatcher.dispatch(
      makeRequest('agentHooks.prepareCodexForWslPane', {
        codexHome: '/home/qa/codex',
        orcaCodexHome: '/home/qa/codex',
        wslDistro: 'Ubuntu'
      })
    )
  ).toMatchObject({ ok: true, result: { state: 'installed' } })
  expect(composed).not.toHaveBeenCalled()
  expect(tokenized).not.toHaveBeenCalled()
  const originalArgs = settings.agentDefaultArgs?.claude
  if (originalArgs === undefined) {
    throw new Error('Missing Claude Arguments fixture')
  }
  const published = launchProfile.composeAgentLaunchProfile(settings)
  for (const [row, params] of Object.entries({
    'settings.get': undefined,
    'settings.update': { machineName: 'Host' },
    'settings.updatePRBotAuthorOverride': { author: 'test', isBot: true },
    'settings.getAgentLaunch': undefined,
    'settings.mutateAgentLaunch': { type: 'permission', agent: 'claude', choice: 'ask' },
    'settings.update legacy': {
      agentDefaultArgs: {
        ...published.agentDefaultArgs,
        claude: `--permission-mode auto ${originalArgs}`
      },
      agentDefaultEnv: { ...published.agentDefaultEnv, goose: { KEEP: 'new' } }
    }
  })) {
    const [method, ingress] = row.split(' ')
    composed.mockClear()
    tokenized.mockClear()
    ingressReceipts.length = 0
    const { value, work } = measureSettingsWork(() =>
      dispatcher.dispatch(makeRequest(method, params))
    )
    const response = await value
    const ingressWork = ingressReceipts.at(-1)
    const currentArgs = settings.agentDefaultArgs?.claude
    if (currentArgs === undefined) {
      throw new Error('Missing Claude Arguments after dispatch')
    }
    expect(response.ok).toBe(true)
    const text = JSON.stringify(response)
    expect(text).toContain(ingress ? '--permission-mode auto' : '--permission-mode default')
    expect(composed).toHaveBeenCalledTimes(ingress ? 2 : 1)
    expect(
      tokenized.mock.calls.reduce((bytes, [text]) => bytes + text.length, 0)
    ).toBeLessThanOrEqual((ingress ? 60 : 6) * currentArgs.length + 12000)
    // Each profile gets14n; three recipes with W<=6 get2(W+1)B construction bytes each.
    const bytes =
        text.length +
        work.bytes +
        (ingressWork ? 42 * Math.max(0, ...ingressWork.inputs.map((input) => input.length)) : 0),
      visits = work.entries + work.visits + 14 * n * (ingress ? 2 : 1),
      comparisons = work.comparisons
    expect(work.entries - (ingressWork?.entries ?? 0) + 14 * n).toBeLessThanOrEqual(40 * n + 8000)
    if (ingressWork) {
      // One original profile plus the three declared Claude recipes' bounded proofs.
      const proof = 3 * 3 * (2 + 10 * (6 + 1)) * (2 * n + 6) + 3 * 4096
      expect(ingressWork.entries + ingressWork.visits + 14 * n).toBeLessThanOrEqual(
        40 * n + 8000 + proof
      )
    }
    expect(comparisons).toBeLessThanOrEqual(4 * (n + 1) * Math.ceil(Math.log2(n + 1)))
    expectSettingsWorkScale(`response-${method}-${!!ingress}`, n, [visits, bytes])
    const namesOnly = method.includes('AgentLaunch')
    const env = settings.agentDefaultEnv
    if (!env?.claude) {
      throw new Error('Missing Claude Environment after dispatch')
    }
    const result = JSON.parse(text).result.settings
    expect(result[namesOnly ? 'environmentNames' : 'agentDefaultEnv'].claude).toEqual(
      namesOnly ? Object.keys(env.claude).sort() : env.claude
    )
    expect(text.includes('private')).toBe(!namesOnly)
    if (ingress) {
      expect(settings.agentPermissionOverrides?.claude).toBe('auto')
      expect(env.goose).toEqual({ KEEP: 'new' })
    }
  }
  expect(JSON.parse(currentReplies[0]!).result.repos[0].externalWorktreeVisibility).toBeUndefined()
})
