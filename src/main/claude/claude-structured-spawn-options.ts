import type { EffortLevel } from '@anthropic-ai/claude-agent-sdk'
import { decodeStructuredAgentSessionOptionValue } from '../../shared/structured-agent-session-option-codec'
import type {
  ClaudeStructuredLaunch,
  ClaudeStructuredSdkOptions
} from './claude-structured-launch-resolution'
import type { ClaudeSession } from './structured/claude-structured-session-state'
import { restoredClaudeStructuredSessionOptions } from './claude-structured-options'
import type { ClaudeCliFlagFact } from './claude-cli-flag-support'

const EFFORT_LEVELS: ReadonlySet<string> = new Set<EffortLevel>([
  'low',
  'medium',
  'high',
  'xhigh',
  'max'
])
/** Saved choices replace configured flags so the CLI receives each flag once. */
function withoutConfiguredFlag(
  options: ClaudeStructuredSdkOptions,
  flag: string
): ClaudeStructuredSdkOptions {
  if (!options.extraArgs || !Object.hasOwn(options.extraArgs, flag)) {
    return options
  }
  const { [flag]: _configured, ...extraArgs } = options.extraArgs
  return { ...options, extraArgs }
}

function isEffortLevel(value: string): value is EffortLevel {
  return EFFORT_LEVELS.has(value)
}

export type ClaudeStructuredSpawnOptions = {
  sdkOptions: ClaudeStructuredSdkOptions
  options: Map<string, string>
  /** Saved Fast must be applied before input when launch settings cannot carry it. */
  fastModeAtStart: boolean
} & Partial<Pick<ClaudeSession, 'cliFlag' | 'flagSettingsControl'>>

/** Pass SDK-valid saved choices through; let the installed CLI reject unsupported values. */
export function claudeStructuredSpawnOptions(input: {
  launch: Pick<ClaudeStructuredLaunch, 'options' | 'resumesTranscript'>
  saved: Readonly<Record<string, string>> | undefined
  effortFlag: ClaudeCliFlagFact
  flagSettingsControl: ClaudeCliFlagFact
}): ClaudeStructuredSpawnOptions {
  const saved = restoredClaudeStructuredSessionOptions(input.saved)
  const options = new Map<string, string>()
  let sdkOptions: ClaudeStructuredSdkOptions = { ...input.launch.options }
  let fastModeAtStart = false
  const model = saved.get('model')
  if (model !== undefined) {
    options.set('model', model)
    sdkOptions = { ...withoutConfiguredFlag(sdkOptions, 'model'), model }
  }
  const effort = saved.get('effort')
  // Without a proven flag, the first message's control applies saved effort where the CLI has one.
  if (effort !== undefined && isEffortLevel(effort) && input.effortFlag === 'supported') {
    options.set('effort', effort)
    sdkOptions = { ...withoutConfiguredFlag(sdkOptions, 'effort'), effort }
  }
  const fastMode = saved.get('fastMode')
  if (fastMode !== undefined) {
    const decoded = decodeStructuredAgentSessionOptionValue('fastMode', fastMode)
    if (typeof decoded === 'boolean') {
      // New sessions may require Fast opt-in before input; explicit --settings must remain intact.
      if (
        (!decoded || input.launch.resumesTranscript) &&
        !Object.hasOwn(sdkOptions.extraArgs ?? {}, 'settings')
      ) {
        options.set('fastMode', fastMode)
        sdkOptions.settings = { fastMode: decoded }
      } else if (input.flagSettingsControl !== 'unsupported') {
        options.set('fastMode', fastMode)
        fastModeAtStart = true
      }
    }
  }
  return { sdkOptions, options, fastModeAtStart }
}

export function adoptClaudeStructuredSpawnOptions(
  session: Pick<
    ClaudeSession,
    | 'translator'
    | 'launchIntent'
    | 'fastModeAtStart'
    | 'appliedInputOptions'
    | 'cliFlag'
    | 'flagSettingsControl'
  >,
  spawn: ClaudeStructuredSpawnOptions
): void {
  const { extraArgs, permissionMode } = spawn.sdkOptions
  // A configured `--model` in the agent's arguments survives when the chat saved none.
  const configuredModel = typeof extraArgs?.model === 'string' ? extraArgs.model : undefined
  session.launchIntent = {
    model: spawn.sdkOptions.model ?? configuredModel,
    permissionMode: Object.hasOwn(extraArgs ?? {}, 'dangerously-skip-permissions')
      ? 'bypassPermissions'
      : permissionMode
  }
  session.fastModeAtStart = spawn.fastModeAtStart
  session.cliFlag = spawn.cliFlag
  session.flagSettingsControl = spawn.flagSettingsControl
  const fastMode = spawn.options.get('fastMode')
  if (fastMode !== undefined && !spawn.fastModeAtStart) {
    session.appliedInputOptions.set('fastMode', fastMode)
  }
  const model = spawn.options.get('model')
  if (model !== undefined) {
    session.translator?.modelWritten(model)
  }
}
