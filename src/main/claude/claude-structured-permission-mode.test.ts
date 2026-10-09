import { describe, expect, it } from 'vitest'
import {
  claudeChatPermissionMode,
  claudePermissionModeNeedsRelaunch,
  claudePermissionModesFor,
  claudePermissionModeWrite,
  claudeSdkPermissionMode
} from './claude-structured-permission-mode'
import type { AgentChatPermissionMode } from '../../shared/agent-chat-permission-mode'

function state(picked?: string, launchPermissionMode?: AgentChatPermissionMode) {
  return {
    options: new Map(picked ? [['permissionMode', picked]] : []),
    ...(launchPermissionMode ? { launchPermissionMode } : {})
  }
}

describe('claudeSdkPermissionMode', () => {
  it('maps each chat mode to the CLI mode of the same meaning', () => {
    expect(claudeSdkPermissionMode('ask')).toBe('default')
    expect(claudeSdkPermissionMode('accept-edits')).toBe('acceptEdits')
    expect(claudeSdkPermissionMode('auto')).toBe('auto')
    expect(claudeSdkPermissionMode('bypass')).toBe('bypassPermissions')
  })
})

describe('claudeChatPermissionMode', () => {
  it('reads the chat pick before the launch mode', () => {
    expect(claudeChatPermissionMode(state('auto', 'bypass'))).toBe('auto')
    expect(claudeChatPermissionMode(state(undefined, 'bypass'))).toBe('bypass')
    expect(claudeChatPermissionMode(state())).toBe('ask')
  })
})

describe('claudePermissionModeNeedsRelaunch', () => {
  // The CLI refuses set_permission_mode bypassPermissions without the launch flag.
  it('needs a relaunch only to reach Full access from a child launched without the flag', () => {
    expect(claudePermissionModeNeedsRelaunch(state('bypass', 'ask'))).toBe(true)
    expect(claudePermissionModeNeedsRelaunch(state('bypass'))).toBe(true)
    expect(claudePermissionModeNeedsRelaunch(state('bypass', 'bypass'))).toBe(false)
    expect(claudePermissionModeNeedsRelaunch(state('ask', 'bypass'))).toBe(false)
    expect(claudePermissionModeNeedsRelaunch(state('auto', 'ask'))).toBe(false)
  })
})

describe('claudePermissionModeWrite', () => {
  it('applies a mode the running child can take live', () => {
    expect(claudePermissionModeWrite(state(undefined, 'ask'), 'accept-edits')).toEqual({
      kind: 'live',
      mode: 'acceptEdits'
    })
    expect(claudePermissionModeWrite(state(undefined, 'bypass'), 'bypass')).toEqual({
      kind: 'live',
      mode: 'bypassPermissions'
    })
    // Leaving Full access never needs a new child.
    expect(claudePermissionModeWrite(state('bypass', 'bypass'), 'ask')).toEqual({
      kind: 'live',
      mode: 'default'
    })
  })

  it('holds Full access for a relaunch when the child lacks the flag', () => {
    expect(claudePermissionModeWrite(state(undefined, 'ask'), 'bypass')).toEqual({
      kind: 'relaunch'
    })
  })

  it('refuses a value that is no Claude chat mode', () => {
    expect(claudePermissionModeWrite(state(), 'bypassPermissions')).toBeNull()
    expect(claudePermissionModeWrite(state(), 'plan')).toBeNull()
  })
})

describe('claudePermissionModesFor', () => {
  it('offers Approve for me until a listed model rules it out', () => {
    expect(claudePermissionModesFor(state('accept-edits'), undefined)).toEqual({
      current: 'accept-edits',
      supported: ['ask', 'accept-edits', 'auto', 'bypass']
    })
    expect(claudePermissionModesFor(state(), { supportsAutoMode: true }).supported).toEqual([
      'ask',
      'accept-edits',
      'auto',
      'bypass'
    ])
    // Claude omits the field for a model without auto mode rather than sending false.
    expect(claudePermissionModesFor(state(), {}).supported).toEqual([
      'ask',
      'accept-edits',
      'bypass'
    ])
    expect(claudePermissionModesFor(state(), { supportsAutoMode: false }).supported).toEqual([
      'ask',
      'accept-edits',
      'bypass'
    ])
  })

  it('names retained Auto intent while withholding a known unsupported selection', () => {
    expect(claudePermissionModesFor(state('auto'), { supportsAutoMode: false })).toEqual({
      current: 'auto',
      supported: ['ask', 'accept-edits', 'bypass']
    })
  })

  // A relaunch-pending Full access is what the next turn runs, so it is what the pill shows.
  it('reports a Full access pick awaiting its relaunch as current', () => {
    expect(claudePermissionModesFor(state('bypass', 'ask'), undefined).current).toBe('bypass')
  })
})
