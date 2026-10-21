// Saved choices seed the CLI launch; changed message choices apply before input.

import type { EffortLevel } from '@anthropic-ai/claude-agent-sdk'
import { decodeStructuredAgentSessionOptionValue } from '../../shared/structured-agent-session-option-codec'
import type {
  ClaudeStructuredLaunch,
  ClaudeStructuredSdkOptions
} from './claude-structured-launch-resolution'
import type { ClaudeSession } from './claude-structured-session-state'
import { restoredClaudeStructuredSessionOptions } from './claude-structured-options'

const EFFORT_LEVELS: ReadonlySet<string> = new Set<EffortLevel>([
  'low',
  'medium',
  'high',
  'xhigh',
  'max'
])
/** The saved value stands in for the agent Arguments' own flag for it: the chat's pick wins, and
 *  the CLI is never handed the flag twice. */
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
  /** The chat's options as the session holds them: what was launched, and a Fast the start applies. */
  options: Map<string, string>
  /** A saved Fast the launch does not carry, which the start applies. */
  fastModeAtStart: boolean
}

/**
 * Every saved value is passed as the user chose it; the CLI's own answer (a turn's error, the
 * settings readback) says what it ran. Only a value no Claude version can parse is left out, by
 * the SDK's types, not the installed binary's: one that binary rejects fails its start.
 */
export function claudeStructuredSpawnOptions(input: {
  launch: Pick<ClaudeStructuredLaunch, 'options' | 'resumesTranscript'>
  saved: Readonly<Record<string, string>> | undefined
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
  if (effort !== undefined) {
    if (isEffortLevel(effort)) {
      options.set('effort', effort)
      sdkOptions = { ...withoutConfiguredFlag(sdkOptions, 'effort'), effort }
    }
  }
  const fastMode = saved.get('fastMode')
  if (fastMode !== undefined) {
    const decoded = decodeStructuredAgentSessionOptionValue('fastMode', fastMode)
    if (typeof decoded === 'boolean') {
      options.set('fastMode', fastMode)
      // A new CLI session may opt in to Fast per session; the first message applies a saved Fast
      // when launch settings cannot carry it.
      if (
        (!decoded || input.launch.resumesTranscript) &&
        !Object.hasOwn(sdkOptions.extraArgs ?? {}, 'settings')
      ) {
        sdkOptions.settings = { fastMode: decoded }
      } else {
        fastModeAtStart = true
      }
    }
  }
  return { sdkOptions, options, fastModeAtStart }
}

/** The published session takes on what its child was launched with. */
export function adoptClaudeStructuredSpawnOptions(
  session: Pick<
    ClaudeSession,
    'translator' | 'launchedModel' | 'fastModeAtStart' | 'appliedInputOptions'
  >,
  spawn: Pick<ClaudeStructuredSpawnOptions, 'options' | 'fastModeAtStart'>
): void {
  session.launchedModel = spawn.options.get('model') ?? null
  session.fastModeAtStart = spawn.fastModeAtStart
  const fastMode = spawn.options.get('fastMode')
  if (fastMode !== undefined && !spawn.fastModeAtStart) {
    session.appliedInputOptions.set('fastMode', fastMode)
  }
  const model = spawn.options.get('model')
  if (model !== undefined) {
    session.translator?.modelWritten(model)
  }
}
