import type { AgentStartupPlanInputs } from '../../shared/agent-startup-plan-inputs'
import {
  buildAgentDraftLaunchPlan,
  buildAgentStartupPlan,
  type AgentStartupPlan
} from '../../shared/tui-agent-startup'
import { planStartupWithPromptCandidate } from '../../shared/startup-line-prompt-carry'
import { buildSleepingAgentLaunchConfig } from '../../shared/sleeping-agent-launch-config'
import type { SleepingAgentLaunchConfig } from '../../shared/agent-session-resume'
import type { TuiAgent } from '../../shared/tui-agent'
import { probeOpenCodeLaunchModelContext } from './opencode-launch-model-context'
import { resolveOpenCodeLaunchModelConfig } from './opencode-launch-model-config'
import {
  isVerifiedOpenCodeConfigModelVersion,
  isVerifiedOpenCodeLegacyModelVersion
} from './opencode-model-version-policy'
import { getTuiAgentLaunchCommand, TUI_AGENT_CONFIG } from '../../shared/tui-agent-config'
import { applyManagedDataAccountEnvironment } from '../managed-data-accounts/launch-environment'
import { OrchestrationError } from '../runtime/orchestration/orchestration-error'
import { probeOpenCodeLaunchCapabilities } from './opencode-launch-capabilities'
import { resolveOpenCodeDirectModelExecutable } from './opencode-model-executable'
import {
  OPENCODE_MODEL_CONFIG_REFUSAL,
  OPENCODE_MODEL_TRANSPORT_REFUSAL,
  OPENCODE_MODEL_VERSION_REFUSAL
} from '../../shared/agent-launch-model-preferences'

type StartupScope = {
  inputs: AgentStartupPlanInputs
  cwd: string
  isWsl?: boolean
  hostIdentity?: string
  signal?: AbortSignal
}

function refuseModel(message = OPENCODE_MODEL_TRANSPORT_REFUSAL): never {
  throw new OrchestrationError('capability_unsupported', message)
}

export async function resolveOpenCodeModelLaunchRoute(
  options: Pick<StartupScope, 'inputs' | 'cwd' | 'hostIdentity'>
) {
  const { inputs } = options
  const command =
    inputs.cmdOverrides.opencode ||
    getTuiAgentLaunchCommand(TUI_AGENT_CONFIG.opencode, inputs.platform)
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries({ ...process.env, ...inputs.agentEnv })) {
    if (value !== undefined) {
      env[key] = value
    }
  }
  applyManagedDataAccountEnvironment(env, { launchAgent: 'opencode' })
  const capabilities = await probeOpenCodeLaunchCapabilities({
    command,
    agent: 'opencode',
    cwd: options.cwd,
    env,
    hostIdentity: options.hostIdentity
  }).catch(() => null)
  const legacy = isVerifiedOpenCodeLegacyModelVersion(capabilities?.version)
  if (!legacy && !isVerifiedOpenCodeConfigModelVersion(capabilities?.version)) {
    refuseModel(OPENCODE_MODEL_VERSION_REFUSAL)
  }
  return { command, env, legacy }
}

export async function prepareOpenCodeModelStartupInputs(
  options: StartupScope
): Promise<{ inputs: AgentStartupPlanInputs; launchConfig?: SleepingAgentLaunchConfig }> {
  const { inputs } = options
  const model = inputs.sessionOptions?.model
  if (
    inputs.agent !== 'opencode' ||
    !Object.values(inputs.sessionOptions ?? {}).some((value) => value !== undefined)
  ) {
    return { inputs }
  }
  if (typeof model !== 'string' || model.trim().length === 0) {
    refuseModel()
  }
  if (
    Object.entries(inputs.sessionOptions ?? {}).some(
      ([key, value]) => key !== 'model' && value !== undefined
    ) ||
    inputs.isRemote ||
    options.isWsl ||
    inputs.platform !== process.platform ||
    options.signal?.aborted
  ) {
    refuseModel()
  }
  const { command, env, legacy } = await resolveOpenCodeModelLaunchRoute(options)
  if (legacy) {
    return { inputs }
  }
  if (inputs.agentArgs?.trim()) {
    refuseModel()
  }
  const executable = await resolveOpenCodeDirectModelExecutable({
    command,
    cwd: options.cwd,
    env
  }).catch(() => null)
  const context = executable
    ? await probeOpenCodeLaunchModelContext({
        executable,
        cwd: options.cwd,
        env,
        signal: options.signal
      }).catch(() => null)
    : null
  const configContent = resolveOpenCodeLaunchModelConfig({
    configContent: env.OPENCODE_CONFIG_CONTENT,
    primaryAgent: context?.primaryAgent,
    model
  })
  if (configContent === null) {
    refuseModel(OPENCODE_MODEL_CONFIG_REFUSAL)
  }
  return {
    inputs: {
      ...inputs,
      agentArgs: '--standalone',
      agentEnv: { ...inputs.agentEnv, OPENCODE_CONFIG_CONTENT: configContent },
      sessionOptions: undefined
    },
    launchConfig: buildSleepingAgentLaunchConfig({
      agentCommand: command,
      agentArgs: inputs.agentArgs,
      agentEnv: inputs.agentEnv
    })
  }
}

export async function buildExecutionHostAgentStartupPlan(
  options: StartupScope & {
    prompt: string
    promptDelivery?: 'auto-submit' | 'draft'
  }
) {
  const prepared = await prepareOpenCodeModelStartupInputs(options)
  if (prepared.launchConfig && options.promptDelivery === 'draft') {
    refuseModel()
  }
  const plan =
    options.promptDelivery === 'draft'
      ? buildAgentDraftLaunchPlan({ ...prepared.inputs, draft: options.prompt })
      : buildAgentStartupPlan({
          ...prepared.inputs,
          prompt: options.prompt,
          allowEmptyPromptLaunch: true
        })
  if (plan && prepared.launchConfig) {
    plan.launchConfig = prepared.launchConfig
    plan.sessionOptions = { ...options.inputs.sessionOptions }
  }
  return plan
}

export async function planExecutionHostStartupWithPromptCandidate(
  options: StartupScope & {
    prompt: string
    host: { shellName?: string; provesAgentInFront: boolean }
  }
): Promise<{ plan: AgentStartupPlan | null; promptCarried: boolean }> {
  const prepared = await prepareOpenCodeModelStartupInputs(options)
  const offered = planStartupWithPromptCandidate(prepared.inputs, options.prompt, options.host)
  if (offered.plan && prepared.launchConfig) {
    offered.plan.launchConfig = prepared.launchConfig
    offered.plan.sessionOptions = { ...options.inputs.sessionOptions }
  }
  return offered
}

export function assertOpenCodeModelLaunchPreferencesAbsent(
  agent: TuiAgent | undefined,
  preferences: Readonly<Record<string, unknown>> | undefined
): void {
  if (
    agent === 'opencode' &&
    Object.values(preferences ?? {}).some((value) => value !== undefined)
  ) {
    refuseModel()
  }
}
