import { expect, it } from 'vitest'
import { agentChatPermissionModes } from '../../shared/agent-launch/permissions/agent-chat-permission-support'
import { DEVIN_LAUNCH_SPEC } from './devin-acp-launch-spec'

// The mode select `session/new` reports on Devin 3000.14.30821.
const MODES = ['accept-edits', 'smart', 'ask', 'plan', 'bypass']

it('launches `devin acp` and drops a mode or model an earlier launch inherited', () => {
  expect(DEVIN_LAUNCH_SPEC.args({ fullAccess: false, pluginDirs: [] })).toEqual(['acp'])
  const env: Record<string, string> = {
    PATH: '/usr/bin',
    DEVIN_PERMISSION_MODE: 'bypass',
    DEVIN_MODEL: 'gpt-6-astra-medium'
  }
  expect(DEVIN_LAUNCH_SPEC.scrubEnvironment!(env, {})).toEqual([
    'DEVIN_PERMISSION_MODE',
    'DEVIN_MODEL'
  ])
  expect(env).toEqual({ PATH: '/usr/bin' })
})

it("sets each of the chat's permission modes from the modes Devin lists", () => {
  const values = DEVIN_LAUNCH_SPEC.permissionModeConfig!.values
  expect(values).toEqual({
    ask: 'ask',
    'accept-edits': 'accept-edits',
    auto: 'smart',
    'full-access': 'bypass'
  })
  expect(Object.values(values).every((mode) => MODES.includes(mode))).toBe(true)
  // Ask questions only in Ask; nothing Orca offers runs Devin's Plan mode behind the picker.
  expect(agentChatPermissionModes('devin')?.modes).toEqual([
    'ask',
    'accept-edits',
    'auto',
    'full-access'
  ])
})

it('lists the account catalog in a session it deletes', () => {
  expect(DEVIN_LAUNCH_SPEC.modelDiscovery).toEqual({
    kind: 'session',
    listingNamesConfiguredModel: false
  })
  expect(DEVIN_LAUNCH_SPEC.account.pin).toEqual({ accountHomeVariable: 'XDG_DATA_HOME' })
})

it('reads `--continue` and `--resume` as the same session store its transcripts name', () => {
  const parse = DEVIN_LAUNCH_SPEC.sessionHistory.parseResumeArgs
  expect(parse(['-c'])).toEqual({ target: null })
  expect(parse(['--continue'])).toEqual({ target: null })
  expect(parse(['--resume'])).toEqual({ target: null })
  expect(parse(['--resume', 'blushing-entrance'])).toEqual({ target: 'blushing-entrance' })
  expect(parse(['-r', 'blushing-entrance'])).toEqual({ target: 'blushing-entrance' })
  expect(parse(['--', 'fix the build'])).toBeNull()
  // History's Devin rows are named by session id, so a prefix resumes the same conversation.
  const matches = DEVIN_LAUNCH_SPEC.sessionHistory.resumeTargetMatches!
  expect(matches('blush', 'blushing-entrance')).toBe(true)
  expect(matches('blushing-entrance', 'blushing-entrance')).toBe(true)
  expect(matches('ajar-arrow', 'blushing-entrance')).toBe(false)
})
