import { describe, expect, it } from 'vitest'
import {
  CLAUDE_STRUCTURED_BASE_OPTIONS,
  claudeStructuredPermissionOptions,
  type ClaudeStructuredSdkOptions
} from './claude-structured-launch-resolution'
import { claudeStructuredSpawnOptions } from './claude-structured-spawn-options'

function launched(
  saved: Record<string, string>,
  options: { resumesTranscript?: boolean; base?: ClaudeStructuredSdkOptions } = {}
) {
  return claudeStructuredSpawnOptions({
    launch: {
      options: options.base ?? CLAUDE_STRUCTURED_BASE_OPTIONS,
      resumesTranscript: options.resumesTranscript ?? true
    },
    saved
  })
}

const BYPASS_LAUNCH: ClaudeStructuredSdkOptions = {
  ...CLAUDE_STRUCTURED_BASE_OPTIONS,
  extraArgs: {
    ...CLAUDE_STRUCTURED_BASE_OPTIONS.extraArgs,
    ...claudeStructuredPermissionOptions('bypassPermissions').extraArgs
  }
}

describe('a Claude chat launched with its saved options', () => {
  it('passes the saved model, effort, Fast and permission mode as launch options', () => {
    const spawn = launched({
      model: 'opus',
      effort: 'high',
      fastMode: 'true',
      permissionMode: 'plan'
    })

    expect(spawn.sdkOptions).toMatchObject({
      model: 'opus',
      effort: 'high',
      settings: { fastMode: true },
      permissionMode: 'plan',
      // The base launch is kept whole.
      includePartialMessages: true,
      extraArgs: { 'replay-user-messages': null }
    })
    expect(Object.fromEntries(spawn.options)).toEqual({
      model: 'opus',
      effort: 'high',
      fastMode: 'true',
      permissionMode: 'plan'
    })
    expect(spawn.skipped).toEqual([])
  })

  // A resolved id, a model newer than any listing Orca holds, a retired one: the CLI's own answer
  // decides, and a turn's model-not-found error drops it then.
  it.each(['claude-sonnet-5', 'claude-next-9', 'claude-retired-1'])(
    'passes the saved model %s as it was picked',
    (model) => {
      const spawn = launched({ model, effort: 'xhigh' })

      expect(spawn.sdkOptions).toMatchObject({ model, effort: 'xhigh' })
      expect(spawn.skipped).toEqual([])
    }
  )

  it('leaves out an effort or permission mode no Claude can parse, and Fast it cannot decode', () => {
    const spawn = launched({ effort: 'ludicrous', permissionMode: 'retired-mode', fastMode: 'yes' })

    expect(spawn.sdkOptions).not.toHaveProperty('effort')
    expect(spawn.sdkOptions).not.toHaveProperty('permissionMode')
    expect(spawn.sdkOptions).not.toHaveProperty('settings')
    expect(spawn.skipped).toEqual(['effort', 'fastMode', 'permissionMode'])
  })

  it('keeps a saved Fast on for a new conversation, for its start to apply', () => {
    const spawn = launched({ fastMode: 'true' }, { resumesTranscript: false })

    expect(spawn.sdkOptions).not.toHaveProperty('settings')
    expect(spawn.options.get('fastMode')).toBe('true')
    expect(spawn.fastModeAtStart).toBe(true)
    expect(spawn.skipped).toEqual([])
  })

  it('passes a saved Fast off to a new conversation', () => {
    const spawn = launched({ fastMode: 'false' }, { resumesTranscript: false })

    expect(spawn.sdkOptions.settings).toEqual({ fastMode: false })
    expect(spawn.fastModeAtStart).toBe(false)
  })

  it('launches a saved bypass under an Agent Permissions bypass with the owned bypass flag', () => {
    const spawn = launched({ permissionMode: 'bypassPermissions' }, { base: BYPASS_LAUNCH })

    expect(spawn.sdkOptions.extraArgs).toEqual({
      'replay-user-messages': null,
      'dangerously-skip-permissions': null
    })
    expect(spawn.sdkOptions).not.toHaveProperty('permissionMode')
    expect(spawn.sdkOptions).not.toHaveProperty('allowDangerouslySkipPermissions')
  })

  it('never widens the Agent Permissions setting to a saved bypass', () => {
    const spawn = launched({ permissionMode: 'bypassPermissions' })

    expect(spawn.sdkOptions.extraArgs).toEqual({ 'replay-user-messages': null })
    expect(spawn.sdkOptions).not.toHaveProperty('allowDangerouslySkipPermissions')
    expect(spawn.skipped).toEqual(['permissionMode'])
  })

  // Known limit: the allow flag that would keep bypass reachable is one older CLIs reject at start.
  it('starts a saved narrower mode under an Agent Permissions bypass without any bypass flag', () => {
    const spawn = launched({ permissionMode: 'acceptEdits' }, { base: BYPASS_LAUNCH })

    expect(spawn.sdkOptions.permissionMode).toBe('acceptEdits')
    expect(spawn.sdkOptions).not.toHaveProperty('allowDangerouslySkipPermissions')
    expect(spawn.sdkOptions.extraArgs).toEqual({ 'replay-user-messages': null })
  })

  it('starts a saved narrower mode without the allow flag when Agent Permissions prompts', () => {
    const spawn = launched({ permissionMode: 'plan' })

    expect(spawn.sdkOptions.permissionMode).toBe('plan')
    expect(spawn.sdkOptions).not.toHaveProperty('allowDangerouslySkipPermissions')
  })
})
