// Per-decision launch context: turns a chosen launch mode into the concrete
// templates and admitted env the command assembler and result builder consume.
// Safe fallback deliberately carries stock catalog argv only — no overrides,
// default args, default env, or the deleted custom's data — so a deleted agent
// can never escalate into a permission-bypassing base configuration (I8).

import type { BuiltInTuiAgent, GlobalSettings, TuiAgent } from '../../shared/types'
import { TUI_AGENT_CONFIG, type TuiAgentConfig } from '../../shared/tui-agent-config'
import { TUI_AGENT_DISPLAY_NAMES } from '../../shared/tui-agent-display-names'
import {
  getTuiAgentDefaultArgs,
  getTuiAgentDefaultEnv
} from '../../shared/tui-agent-launch-defaults'
import type { AgentCatalog } from '../../shared/agent-catalog-normalization'
import type { AgentLaunchNotice } from '../../shared/agent-launch-contract'
import type { LaunchDecision } from './resolve-agent-selection'
import {
  admitBuiltInEnv,
  admitCustomEnv,
  type LaunchClientKind
} from './resolve-agent-env-admission'

export type LaunchContext = {
  mode: 'built-in' | 'custom' | 'safe-fallback'
  requestedAgent: TuiAgent
  baseAgent: BuiltInTuiAgent
  displayLabel: string
  config: TuiAgentConfig
  commandOverride?: string | null
  prefixOverride?: string | null
  argsTemplate: string
  isCustomArgs: boolean
  env: Record<string, string>
  envPolicy: 'full' | 'withheld' | 'none'
  notices: AgentLaunchNotice[]
  /** Fingerprint source for the normalized definition/replay policy. */
  definitionDigestSource: unknown
}

/** Read the configured per-built-in default args, preserving the shipped YOLO
 *  fallback when the key was never touched (mirrors resolveTuiAgentLaunchArgs
 *  without importing the soon-private helper). */
function builtInArgsTemplate(base: BuiltInTuiAgent, settings: GlobalSettings): string {
  const configured = settings.agentDefaultArgs
  if (configured && Object.hasOwn(configured, base)) {
    return configured[base] ?? ''
  }
  return getTuiAgentDefaultArgs(base)
}

function builtInEnv(base: BuiltInTuiAgent, settings: GlobalSettings): Record<string, string> {
  const configured = settings.agentDefaultEnv
  if (configured && Object.hasOwn(configured, base)) {
    return { ...configured[base] }
  }
  return getTuiAgentDefaultEnv(base)
}

function labelForCustomId(agent: TuiAgent, base: BuiltInTuiAgent, catalog: AgentCatalog): string {
  return (
    catalog.liveById.get(agent as never)?.label ??
    catalog.tombstonesById.get(agent as never)?.label ??
    TUI_AGENT_DISPLAY_NAMES[base]
  )
}

export function buildLaunchContext(
  decision: Extract<LaunchDecision, { launch: 'built-in' | 'custom' | 'safe-fallback' }>,
  catalog: AgentCatalog,
  settings: GlobalSettings,
  client: LaunchClientKind
): LaunchContext {
  if (decision.launch === 'built-in') {
    const base = decision.agent
    const env = admitBuiltInEnv(builtInEnv(base, settings))
    return {
      mode: 'built-in',
      requestedAgent: base,
      baseAgent: base,
      displayLabel: TUI_AGENT_DISPLAY_NAMES[base],
      config: TUI_AGENT_CONFIG[base],
      prefixOverride: settings.agentCmdOverrides?.[base] ?? null,
      argsTemplate: builtInArgsTemplate(base, settings),
      isCustomArgs: false,
      env: env.env,
      envPolicy: env.policy,
      notices: [],
      definitionDigestSource: {
        prefix: settings.agentCmdOverrides?.[base] ?? null,
        args: builtInArgsTemplate(base, settings),
        // The fingerprint otherwise sees built-in env only as a policy flag, so
        // a changed agentDefaultEnv must land here or it would pass the
        // admission recheck (same gap class as the per-launch-args argv digest).
        env: builtInEnv(base, settings)
      }
    }
  }

  if (decision.launch === 'custom') {
    const definition = catalog.liveById.get(decision.agent as never)
    const base = decision.base
    const admission = admitCustomEnv(definition?.env ?? {}, client, definition?.syncEnv ?? false)
    const notices: AgentLaunchNotice[] = admission.withheld
      ? [{ code: 'env_withheld', label: definition?.label ?? TUI_AGENT_DISPLAY_NAMES[base] }]
      : []
    return {
      mode: 'custom',
      requestedAgent: decision.agent,
      baseAgent: base,
      displayLabel: definition?.label ?? TUI_AGENT_DISPLAY_NAMES[base],
      config: TUI_AGENT_CONFIG[base],
      commandOverride: definition?.commandOverride ?? null,
      argsTemplate: definition?.args ?? '',
      isCustomArgs: true,
      env: admission.env,
      envPolicy: admission.policy,
      notices,
      definitionDigestSource: definition ?? null
    }
  }

  // safe-fallback: stock catalog argv only, stale custom id retained as requested.
  const base = decision.base
  return {
    mode: 'safe-fallback',
    requestedAgent: decision.requestedAgent,
    baseAgent: base,
    displayLabel: labelForCustomId(decision.requestedAgent, base, catalog),
    config: TUI_AGENT_CONFIG[base],
    argsTemplate: '',
    isCustomArgs: false,
    env: Object.create(null) as Record<string, string>,
    envPolicy: 'none',
    notices: [
      {
        code: decision.notice,
        label: labelForCustomId(decision.requestedAgent, base, catalog),
        baseAgent: base
      }
    ],
    definitionDigestSource: { safeFallbackBase: base }
  }
}
