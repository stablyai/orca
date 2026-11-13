import { afterEach, expect, it, vi } from 'vitest'
import * as sdk from '@anthropic-ai/claude-agent-sdk'
import { createHash } from 'node:crypto'
import { createClaudeAdvisoryControls } from './claude-advisory-controls'

afterEach(() => vi.restoreAllMocks())

it('admits a bound advisor only after its native account, model and effort match', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000)
  const account = {
    email: 'fixture@example.invalid',
    organization: 'fixture-org',
    apiProvider: 'firstParty',
    apiKeySource: 'none',
    tokenSource: 'oauth',
    subscriptionType: 'max'
  }
  const fingerprint = `claude:${createHash('sha256')
    .update(JSON.stringify([account.email, account.organization]))
    .digest('hex')}`
  const binding = {
    accountFingerprint: fingerprint,
    model: 'claude-sonnet-5',
    effort: 'high' as const
  }
  const policy = {
    schema: 2,
    dataScope: 'published',
    sourcePin: 'a'.repeat(40),
    deadlineAt: 1_800_000_030_000,
    maxModelCalls: 4,
    binding,
    artifacts: [
      {
        path: 'note.txt',
        text: 'hello',
        sha256: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824'
      }
    ]
  }
  const controls = createClaudeAdvisoryControls(policy, sdk, binding)
  const initialized = async () => ({ hooks_applied: true, hook_on_failure_supported: true })
  const settings = { applied: { model: binding.model, effort: 'high' } }
  try {
    await expect(
      controls.beforeWrite(initialized, undefined, async () => ({ account, settings }))
    ).resolves.toBeUndefined()
    for (const changed of [
      { account: { ...account, email: 'foreign@example.invalid' }, settings },
      { account: { ...account, apiKeySource: 'ANTHROPIC_API_KEY' }, settings },
      { account: { ...account, apiProvider: 'bedrock' }, settings },
      { account: { ...account, subscriptionType: undefined }, settings },
      { account, settings: { applied: { model: binding.model, effort: 'low' } } },
      { account, settings: { applied: { model: 'other-model', effort: 'high' } } }
    ]) {
      await expect(
        controls.beforeWrite(initialized, undefined, async () => changed)
      ).rejects.toThrow('Advisor native binding unproven.')
    }
    await expect(controls.beforeWrite(initialized)).rejects.toThrow(
      'Advisor native binding unproven.'
    )
  } finally {
    controls.end()
  }
})
