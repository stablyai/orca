import { describe, expect, it } from 'vitest'
import { ANTIGRAVITY_SESSION_OPTION_CATALOG } from '../../../../../../shared/agent-session-option-catalog-antigravity'
import { resolveAgentSessionOptionLaunch } from '../../../../../../shared/agent-session-option-launch'
import { resolveWorkerLaunchPreferences } from './worker-launch-preferences'
import { resolveAgentLaunchCommand } from '../../../../../../shared/tui-agent-launch-command'

// agy 1.2.7 selection checks: matching levels resolve; conflicting and unavailable levels fail.
describe('Antigravity worker launch options', () => {
  it.each([
    ['gemini-3.7-flash-low', 'low'],
    ['gemini-3.7-flash', 'high'],
    ['gemini-3.1-pro', 'high']
  ])('launches %s with effort %s', (model, effort) => {
    const result = resolveWorkerLaunchPreferences({ agent: 'antigravity', model, effort })
    expect(result.preferences).toEqual({ model, effort })
    expect(result.receipt.effective).toEqual({ agent: 'antigravity', model, effort })
    expect(resolveAgentSessionOptionLaunch('antigravity', result.preferences, [], false)).toEqual({
      args: ['--model', model, '--effort', effort],
      appliedValues: { model, effort }
    })
  })

  it.each([
    ['gemini-3.7-flash-low', 'high'],
    ['gemini-3.1-pro', 'medium'],
    ['Gemini 3.7 Flash (Low)', 'high'],
    ['unverified-family', 'high']
  ])('rejects unsupported %s / %s before issuing a receipt', (model, effort) => {
    expect(() => resolveWorkerLaunchPreferences({ agent: 'antigravity', model, effort })).toThrow(
      `does not support effort ${effort}`
    )
  })

  it.each(['Gemini 3.7 Flash (Low)', 'future-account-model', 'gemini-3.7-flash-low'])(
    'preserves model-only selector %s without inventing an effort',
    (model) => {
      const { preferences } = resolveWorkerLaunchPreferences({ agent: 'antigravity', model })
      expect(resolveAgentSessionOptionLaunch('antigravity', preferences)).toEqual({
        args: ['--model', model],
        appliedValues: { model }
      })
    }
  )

  it('removes conflicting configured model and effort arguments for a model-only worker', () => {
    const plan = resolveAgentLaunchCommand({
      agent: 'antigravity',
      cmdOverrides: {},
      platform: 'linux',
      shell: 'posix',
      agentArgs: '--model=gemini-3.7-flash-high --effort high --sandbox',
      sessionOptions: { model: 'gemini-3.7-flash-low' },
      sessionOptionsOverrideAgentArgs: true
    })
    expect(plan).toMatchObject({
      ok: true,
      command: "agy '--sandbox' '--model' 'gemini-3.7-flash-low'",
      appliedSessionOptions: { model: 'gemini-3.7-flash-low' }
    })
  })

  it('refuses an effort embedded in the custom launcher instead of misreporting the model', () => {
    expect(
      resolveAgentLaunchCommand({
        agent: 'antigravity',
        cmdOverrides: { antigravity: 'agy --effort high' },
        platform: 'linux',
        shell: 'posix',
        sessionOptions: { model: 'gemini-3.7-flash-low' },
        sessionOptionsOverrideAgentArgs: true
      })
    ).toMatchObject({ ok: false })
  })

  it('keeps discovery membership and model-specific options from actual agy output', () => {
    const models = ANTIGRAVITY_SESSION_OPTION_CATALOG.listModels?.parse(
      'Fetching available models...\ngemini-3.7-flash-low\tGemini 3.7 Flash (Low)\nGemini 3.5 Flash (High)\n'
    )
    expect(models?.map(({ id }) => id)).toEqual(['gemini-3.7-flash-low', 'Gemini 3.5 Flash (High)'])
    expect(models?.[0].options[0].kind).toMatchObject({
      choices: [{ value: 'low', label: 'Low' }]
    })
    expect(models?.[1].options).toEqual([])
    expect(ANTIGRAVITY_SESSION_OPTION_CATALOG.models).toEqual([])
  })
})
