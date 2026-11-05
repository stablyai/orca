import type { AgentLaunchAccountReceipt } from '../../shared/agent-launch/contracts/agent-launch-intent'
import { AsyncLocalStorage } from 'node:async_hooks'
import { basename, dirname } from 'node:path'
import { normalizeRuntimePathForComparison } from '../../shared/cross-platform-path'
import type { OrchestrationCompatibilityEvidence } from '../../shared/orchestration-compatibility-evidence'
import type { RpcContext } from '../runtime/rpc/core'
import { getClaudeProfileRouter } from './claude-profile-installed-router'
import { claudeProfileLaunchPointer } from './claude-profile-paths'
import type { ClaudeProfileRouter } from './claude-profile-router'
import type { ClaudeRuntimeAuthPreparation } from './runtime-auth/runtime-auth-types'

type ClaudeLaunchAccount = {
  router: ClaudeProfileRouter
  preparation: ClaudeRuntimeAuthPreparation
  receipt: AgentLaunchAccountReceipt
  used: boolean
}

// Bind concurrent launches without changing the UI account selection.
const launches = new AsyncLocalStorage<ClaudeLaunchAccount>()

export function inheritedClaudeLaunchPreparation(
  router: Pick<ClaudeProfileRouter, 'selectedProfile'>
): ClaudeRuntimeAuthPreparation | undefined {
  const launch = launches.getStore()
  if (launch?.router !== router) {
    return undefined
  }
  launch.used = true
  return launch.preparation
}

export function claudeLaunchAccountReceipt(): AgentLaunchAccountReceipt | undefined {
  const launch = launches.getStore()
  return launch?.used ? launch.receipt : undefined
}

function accountForHome(router: ClaudeProfileRouter, home: string): string | null | undefined {
  const same = (other: string) =>
    normalizeRuntimePathForComparison(home) === normalizeRuntimePathForComparison(other)
  if (!home || same(router.systemDefaultHome())) {
    return null
  }
  const id = basename(dirname(home))
  const account = router.savedAccount(id)
  if (account && account.managedAuthRuntime !== 'wsl' && same(router.accountHome(id))) {
    return id
  }
  return undefined
}

async function callerAccount(
  router: ClaudeProfileRouter,
  context: RpcContext,
  evidence: OrchestrationCompatibilityEvidence | undefined
): Promise<string | null | undefined> {
  if (!evidence?.terminalHandle || evidence.host || typeof evidence.claudeConfigDir !== 'string') {
    return undefined
  }
  try {
    const terminal = await context.runtime.showTerminal(evidence.terminalHandle)
    if (
      !terminal.connected ||
      terminal.agentIdentity !== 'claude' ||
      !(await context.runtime.isTerminalRunningAgent(evidence.terminalHandle)) ||
      (evidence.paneKey && evidence.paneKey !== `${terminal.tabId}:${terminal.leafId}`)
    ) {
      return undefined
    }
    return accountForHome(router, evidence.claudeConfigDir)
  } catch {
    return undefined
  }
}

export async function withInheritedClaudeLaunchAccount<T>(
  context: RpcContext,
  method: string,
  params: unknown,
  evidence: OrchestrationCompatibilityEvidence | undefined,
  run: () => T | Promise<T>
): Promise<T> {
  if (
    context.caller?.kind !== 'local-cli' ||
    ![
      'agent.launch',
      'agent.launchReplay',
      'orchestration.workerStart',
      'worktree.create'
    ].includes(method) ||
    typeof params !== 'object' ||
    params === null ||
    !('agent' in params) ||
    params.agent !== 'claude' ||
    ('accountEnv' in params && params.accountEnv !== undefined) ||
    ('reuseTerminal' in params && params.reuseTerminal !== undefined) ||
    ('on' in params && params.on !== undefined)
  ) {
    return run()
  }
  const router = getClaudeProfileRouter()
  if (!router) {
    return run()
  }
  if ('target' in params && typeof params.target === 'object' && params.target !== null) {
    const target = params.target
    if (
      'kind' in target &&
      target.kind === 'existing' &&
      'worktree' in target &&
      typeof target.worktree === 'string'
    ) {
      const workspace = await context.runtime.showTerminalWorkspaceLaunchScope(target.worktree)
      if (workspace.connectionId) {
        return run()
      }
    }
    if (
      'create' in target &&
      typeof target.create === 'object' &&
      target.create !== null &&
      'repoHostId' in target.create &&
      target.create.repoHostId &&
      target.create.repoHostId !== 'local'
    ) {
      return run()
    }
  }
  const inherited = await callerAccount(router, context, evidence)
  const selected = inherited === undefined ? router.preparation() : undefined
  const id =
    inherited ??
    (inherited === null
      ? null
      : selected?.provenance.startsWith('profile:')
        ? selected.provenance.slice('profile:'.length)
        : null)
  const home = id === null ? router.systemDefaultHome() : await router.prepareAccount(id)
  const pointer = claudeProfileLaunchPointer(router.pointerPath, id, home)
  // Omit an unset user dir so Claude falls back to its own default instead of reading ''.
  const configDir = id === null ? router.userConfigDir() : home
  const launch: ClaudeLaunchAccount = {
    router,
    used: false,
    receipt: {
      id,
      email: id === null ? null : (router.savedAccount(id)?.email ?? null),
      source: inherited === undefined ? 'selected' : 'caller'
    },
    preparation: {
      configDir: home,
      runtime: 'host',
      wslDistro: null,
      wslLinuxConfigDir: null,
      provenance: id === null ? 'system' : `profile:${id}`,
      envPatch: {
        ORCA_CLAUDE_PROFILE_POINTER: pointer,
        ...(configDir ? { CLAUDE_CONFIG_DIR: configDir } : {}),
        ORCA_CLAUDE_INJECTED_CONFIG_DIR: id === null ? '' : home
      }
    }
  }
  return launches.run(launch, async () => {
    const result = await run()
    return launch.used && typeof result === 'object' && result !== null && !('account' in result)
      ? { ...result, account: launch.receipt }
      : result
  })
}
