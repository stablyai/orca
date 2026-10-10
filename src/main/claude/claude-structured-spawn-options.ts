// A chat's saved options as the Claude child's launch options. The child starts already running
// them, so its first message can be written at once instead of waiting for initialize to answer and
// a control request to apply each one.

import type { EffortLevel, PermissionMode } from '@anthropic-ai/claude-agent-sdk'
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
const PERMISSION_MODES: ReadonlySet<string> = new Set<PermissionMode>([
  'default',
  'acceptEdits',
  'bypassPermissions',
  'plan',
  'dontAsk',
  'auto'
])

/** Whether `options` launch with the Agent Permissions bypass. */
function claudeStructuredOptionsBypassPermissions(options: ClaudeStructuredSdkOptions): boolean {
  return options.extraArgs?.['dangerously-skip-permissions'] !== undefined
}

/** `options` launched in `mode` instead of the mode they carry; never more than they allow. */
function claudeStructuredOptionsWithPermissionMode(
  options: ClaudeStructuredSdkOptions,
  mode: PermissionMode
): ClaudeStructuredSdkOptions {
  if (mode === 'bypassPermissions') {
    return options
  }
  // Known limit: no switch back to bypass later; that needs the allow flag older CLIs reject.
  const { 'dangerously-skip-permissions': _bypass, ...extraArgs } = options.extraArgs ?? {}
  return { ...options, permissionMode: mode, extraArgs }
}

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

function isPermissionMode(value: string): value is PermissionMode {
  return PERMISSION_MODES.has(value)
}

export type ClaudeStructuredSpawnOptions = {
  sdkOptions: ClaudeStructuredSdkOptions
  /** The chat's options as the session holds them: what was launched, and a Fast the start applies. */
  options: Map<string, string>
  /** Saved options left out: the provider's own value wins and is re-persisted. */
  skipped: readonly string[]
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
  const skipped: string[] = []
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
    } else {
      skipped.push('effort')
    }
  }
  const fastMode = saved.get('fastMode')
  if (fastMode !== undefined) {
    const decoded = decodeStructuredAgentSessionOptionValue('fastMode', fastMode)
    if (typeof decoded !== 'boolean') {
      skipped.push('fastMode')
    } else {
      options.set('fastMode', fastMode)
      // A new CLI session may opt in to Fast per session, which only its settings say, and the
      // agent Arguments' own `--settings` would be replaced by one carrying Fast: either way the
      // start applies the saved Fast once it has read them (`applyClaudeStartFastMode`).
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
  const permissionMode = saved.get('permissionMode')
  if (permissionMode !== undefined) {
    // Bypass is the Agent Permissions setting's to grant; a saved pick never widens it.
    if (
      isPermissionMode(permissionMode) &&
      (permissionMode !== 'bypassPermissions' ||
        claudeStructuredOptionsBypassPermissions(input.launch.options))
    ) {
      options.set('permissionMode', permissionMode)
      sdkOptions = claudeStructuredOptionsWithPermissionMode(sdkOptions, permissionMode)
    } else {
      skipped.push('permissionMode')
    }
  }
  return { sdkOptions, options, skipped, fastModeAtStart }
}

/** The published session takes on what its child was launched with. */
export function adoptClaudeStructuredSpawnOptions(
  session: Pick<
    ClaudeSession,
    'restoreSkippedOptions' | 'translator' | 'launchedModel' | 'fastModeAtStart'
  >,
  spawn: Pick<ClaudeStructuredSpawnOptions, 'options' | 'skipped' | 'fastModeAtStart'>
): void {
  session.launchedModel = spawn.options.get('model') ?? null
  session.fastModeAtStart = spawn.fastModeAtStart
  for (const key of spawn.skipped) {
    session.restoreSkippedOptions.add(key)
  }
  const model = spawn.options.get('model')
  if (model !== undefined) {
    session.translator?.modelWritten(model)
  }
  // The journal's window was measured under a mode this child did not take (`opusplan`'s plan
  // mode runs Opus); a launch never leaves a model out.
  if (spawn.skipped.includes('permissionMode')) {
    session.translator?.modelMayHaveChanged()
  }
}
