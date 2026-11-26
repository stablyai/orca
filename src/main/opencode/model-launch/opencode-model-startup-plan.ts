import { resolveSpawnAgentProgram } from '../../managed-agent-cli/spawn-agent-program-selection'
import {
  launchCommandProvenance,
  launchProgramHead,
  matchesStockLaunchProgram,
  replaceLaunchExecutable,
  stockLaunchProgram
} from '../../../shared/agent-launch/startup/managed-agent-launch-program'
import { readLaunchPosition } from '../../../shared/agent-launch/startup/launch-position'
import { resolveAgentLaunchCommand } from '../../../shared/agent-launch/startup/tui-agent-launch-command'
import { resolveStartupShell } from '../../../shared/agent-launch/startup/tui-agent-startup-shell'
import type { AgentStartupPlanInputs } from '../../../shared/agent-launch/startup/agent-startup-plan-inputs'
import {
  buildAgentDraftLaunchPlan,
  buildAgentStartupPlan,
  type AgentStartupPlan
} from '../../../shared/agent-launch/startup/tui-agent-startup'
import { planStartupWithPromptCandidate } from '../../../shared/agent-launch/startup/startup-line-prompt-carry'
import { buildSleepingAgentLaunchConfig } from '../../../shared/agent-session/lifecycle/resume/sleeping-agent-launch-config'
import type { SleepingAgentLaunchConfig } from '../../../shared/agent-session/lifecycle/agent-session-resume'
import type { TuiAgent } from '../../../shared/agent-launch/catalog/tui-agent'
import { probeOpenCodeLaunchModelContext } from './opencode-launch-model-context'
import { resolveOpenCodeLaunchModelConfig } from './opencode-launch-model-config'
import {
  isVerifiedOpenCodeConfigModelVersion,
  isVerifiedOpenCodeLegacyModelVersion
} from './opencode-model-version-policy'
import { applyManagedDataAccountEnvironment } from '../../managed-data-accounts/launch-environment'
import { OrchestrationError } from '../../runtime/orchestration/orchestration-error'
import { probeOpenCodeLaunchCapabilities } from './opencode-launch-capabilities'
import { resolveOpenCodeDirectModelExecutable } from './opencode-model-executable'
import {
  OPENCODE_MODEL_CONFIG_REFUSAL,
  OPENCODE_MODEL_TRANSPORT_REFUSAL,
  OPENCODE_MODEL_VERSION_REFUSAL
} from '../../../shared/agent-launch/choices/agent-launch-model-preferences'

type StartupScope = {
  inputs: AgentStartupPlanInputs
  cwd: string
  isWsl?: boolean
  shellPath?: string
  hostIdentity?: string
  signal?: AbortSignal
}

function refuseModel(message = OPENCODE_MODEL_TRANSPORT_REFUSAL): never {
  throw new OrchestrationError('capability_unsupported', message)
}

export async function resolveOpenCodeModelLaunchRoute(
  options: Pick<StartupScope, 'inputs' | 'cwd' | 'hostIdentity' | 'shellPath'>
) {
  const { inputs } = options
  const stock = stockLaunchProgram('opencode', inputs.platform)
  const override = inputs.cmdOverrides.opencode
  const commandProvenance = launchCommandProvenance(override, stock, inputs.platform)
  const command = commandProvenance === 'generated' ? stock : (override ?? stock)
  const shell = resolveStartupShell(inputs.platform, inputs.shell)
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries({ ...process.env, ...inputs.agentEnv })) {
    if (value !== undefined) {
      env[process.platform === 'win32' && /^(path|pathext)$/i.test(key) ? key.toUpperCase() : key] =
        value
    }
  }
  applyManagedDataAccountEnvironment(env, { launchAgent: 'opencode' })
  const selected =
    commandProvenance === 'generated'
      ? (
          await resolveSpawnAgentProgram(
            {
              env,
              cwd: options.cwd,
              shellPath: options.shellPath,
              launchConfig: { agentEnv: inputs.agentEnv, agentArgs: '' }
            },
            shell,
            [stock],
            undefined,
            undefined
          )
        ).result
      : undefined
  if (selected && !('path' in selected)) {
    refuseModel(OPENCODE_MODEL_VERSION_REFUSAL)
  }
  const selectedExecutable = selected?.path
  const program = selectedExecutable ? launchProgramHead(selectedExecutable, shell) : command
  const capabilities = await probeOpenCodeLaunchCapabilities({
    command: program,
    agent: 'opencode',
    shell: inputs.shell,
    cwd: options.cwd,
    env,
    hostIdentity: options.hostIdentity
  }).catch(() => null)
  const legacy = isVerifiedOpenCodeLegacyModelVersion(capabilities?.version)
  if (!legacy && !isVerifiedOpenCodeConfigModelVersion(capabilities?.version)) {
    refuseModel(OPENCODE_MODEL_VERSION_REFUSAL)
  }
  return { command, program, env, legacy, commandProvenance, selectedExecutable }
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
  const { command, program, env, legacy, commandProvenance, selectedExecutable } =
    await resolveOpenCodeModelLaunchRoute(options)
  const launchConfig = buildSleepingAgentLaunchConfig({
    agentCommand: selectedExecutable ? program : command,
    selectedExecutable,
    commandProvenance,
    agentArgs: inputs.agentArgs,
    agentEnv: inputs.agentEnv
  })
  if (legacy) {
    if (!selectedExecutable) {
      return { inputs }
    }
    const shell = resolveStartupShell(inputs.platform, inputs.shell)
    const legacyLaunch = resolveAgentLaunchCommand({ ...inputs, shell })
    const recorded = legacyLaunch.ok ? legacyLaunch.resumeLaunch.agentCommand : undefined
    const head = recorded ? readLaunchPosition(recorded, shell) : null
    if (head && recorded && matchesStockLaunchProgram(head.executable, command, inputs.platform)) {
      launchConfig.agentCommand = replaceLaunchExecutable(recorded, shell, head, selectedExecutable)
    }
    return { inputs, launchConfig }
  }
  if (inputs.agentArgs?.trim()) {
    refuseModel()
  }
  const executable =
    selectedExecutable ??
    (await resolveOpenCodeDirectModelExecutable({
      command: program,
      shell: inputs.shell,
      cwd: options.cwd,
      env
    }).catch(() => null))
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
    launchConfig
  }
}

export async function buildExecutionHostAgentStartupPlan(
  options: StartupScope & {
    prompt: string
    promptDelivery?: 'auto-submit' | 'draft'
  }
) {
  const prepared = await prepareOpenCodeModelStartupInputs(options)
  if (
    prepared.launchConfig &&
    !prepared.inputs.sessionOptions &&
    options.promptDelivery === 'draft'
  ) {
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
