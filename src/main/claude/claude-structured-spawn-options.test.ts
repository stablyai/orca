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

const FULL_ACCESS_LAUNCH: ClaudeStructuredSdkOptions = {
  ...CLAUDE_STRUCTURED_BASE_OPTIONS,
  extraArgs: {
    ...CLAUDE_STRUCTURED_BASE_OPTIONS.extraArgs,
    ...claudeStructuredPermissionOptions('full-access').extraArgs
  }
}

describe('a Claude chat launched with its saved options', () => {
  it('passes the saved model, effort and Fast as launch options', () => {
    const spawn = launched({ model: 'opus', effort: 'high', fastMode: 'true' })

    expect(spawn.sdkOptions).toMatchObject({
      model: 'opus',
      effort: 'high',
      settings: { fastMode: true },
      // The base launch is kept whole.
      includePartialMessages: true,
      extraArgs: { 'replay-user-messages': null }
    })
    expect(Object.fromEntries(spawn.options)).toEqual({
      model: 'opus',
      effort: 'high',
      fastMode: 'true'
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

  it('leaves out an effort no Claude can parse, and Fast it cannot decode', () => {
    const spawn = launched({ effort: 'ludicrous', fastMode: 'yes' })

    expect(spawn.sdkOptions).not.toHaveProperty('effort')
    expect(spawn.sdkOptions).not.toHaveProperty('settings')
    expect(spawn.skipped).toEqual(['effort', 'fastMode'])
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

  // The SDK writes the agent Arguments after its own options, so left in, the Arguments' flag would
  // reach the CLI as a second `--model` after the chat's pick.
  it("replaces the agent Arguments' model and effort with the chat's saved ones", () => {
    const base = {
      ...CLAUDE_STRUCTURED_BASE_OPTIONS,
      extraArgs: { ...CLAUDE_STRUCTURED_BASE_OPTIONS.extraArgs, model: 'opus', effort: 'max' }
    }

    expect(launched({ model: 'sonnet', effort: 'low' }, { base }).sdkOptions).toMatchObject({
      model: 'sonnet',
      effort: 'low',
      extraArgs: { 'replay-user-messages': null }
    })
    expect(launched({ model: 'sonnet', effort: 'low' }, { base }).sdkOptions.extraArgs).toEqual({
      'replay-user-messages': null
    })
    // With nothing saved, the Arguments decide.
    expect(launched({}, { base }).sdkOptions.extraArgs).toEqual(base.extraArgs)
  })

  // One `--settings` reaches the CLI: the Arguments' file is kept, and the start applies Fast.
  it.each(['true', 'false'])(
    "keeps the agent Arguments' settings and leaves a saved Fast %s to the start",
    (fastMode) => {
      const base = {
        ...CLAUDE_STRUCTURED_BASE_OPTIONS,
        extraArgs: { ...CLAUDE_STRUCTURED_BASE_OPTIONS.extraArgs, settings: '/repo/claude.json' }
      }
      const spawn = launched({ fastMode }, { base })

      expect(spawn.sdkOptions).not.toHaveProperty('settings')
      expect(spawn.sdkOptions.extraArgs).toEqual(base.extraArgs)
      expect(spawn.options.get('fastMode')).toBe(fastMode)
      expect(spawn.fastModeAtStart).toBe(true)
    }
  )

  // The chat's permission mode is the launch's, never a saved option: the record keeps it whole.
  it.each(['full-access', 'plan', 'bypassPermissions'])(
    'leaves the launch permission alone with a saved permission mode %s',
    (permissionMode) => {
      const spawn = launched({ permissionMode }, { base: FULL_ACCESS_LAUNCH })

      expect(spawn.sdkOptions).toEqual(FULL_ACCESS_LAUNCH)
      expect(spawn.options.size).toBe(0)
      expect(spawn.skipped).toEqual([])
    }
  )
})
