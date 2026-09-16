import { describe, expect, it } from 'vitest'
import { codexStructuredPermissionArgsForSettings } from './codex-structured-permission-mode'

const BYPASS = ['--dangerously-bypass-approvals-and-sandbox']

describe('codexStructuredPermissionArgsForSettings', () => {
  it('bypasses when the user has never opened Agent settings', () => {
    expect(codexStructuredPermissionArgsForSettings({ agentDefaultArgs: {} })).toEqual(BYPASS)
    expect(codexStructuredPermissionArgsForSettings({})).toEqual(BYPASS)
    expect(codexStructuredPermissionArgsForSettings(null)).toEqual(BYPASS)
    expect(codexStructuredPermissionArgsForSettings({ agentDefaultArgs: { claude: '' } })).toEqual(
      BYPASS
    )
  })

  it('bypasses when Yolo wrote the flag, alone or beside other tokens', () => {
    for (const codex of [
      '--dangerously-bypass-approvals-and-sandbox',
      '--dangerously-bypass-approvals-and-sandbox --model gpt-5.6-sol',
      '--model gpt-5.6-sol --dangerously-bypass-approvals-and-sandbox'
    ]) {
      expect(
        codexStructuredPermissionArgsForSettings({ agentDefaultArgs: { codex } }),
        codex
      ).toEqual(BYPASS)
    }
  })

  it('leaves the approval prompts on when Manual cleared the flag', () => {
    expect(codexStructuredPermissionArgsForSettings({ agentDefaultArgs: { codex: '' } })).toEqual(
      []
    )
  })

  // The passthrough that used to carry these to app-server is gone on purpose; only the
  // permission posture is derived, and nothing else from the field reaches argv.
  it('carries nothing but the permission posture out of the arguments field', () => {
    expect(
      codexStructuredPermissionArgsForSettings({
        agentDefaultArgs: {
          codex: '--profile review --add-dir /repo -c model_reasoning_effort=high'
        }
      })
    ).toEqual([])
  })
})
