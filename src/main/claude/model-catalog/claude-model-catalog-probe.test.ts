import type { AgentModelCatalogSuccess } from '../../native-chat/agent-model-catalog/agent-model-catalog-entry'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { createClaudeModelCatalogProbe } from './claude-model-catalog-probe'
import { resolveStructuredAgentCommand } from '../../native-chat/agent-launch/structured-agent-command-resolution'

const AUTH_POLICY = { account: 'system' } as const

const HOME = (path: string): { variable: string; path: string } => ({
  variable: 'CLAUDE_CONFIG_DIR',
  path
})

function probeDeps(command = `"${process.execPath}"`): {
  resolveCommand: () => { command: string; prefixArgs: string[] }
  resolveEnv: () => Record<string, string>
  resolveInheritedEnv: () => Promise<Record<string, string>>
  resolveAuthPolicy: () => typeof AUTH_POLICY
} {
  return {
    resolveCommand: () =>
      resolveStructuredAgentCommand('claude', {
        agentCmdOverrides: { claude: command }
      }),
    resolveEnv: () => ({ ANTHROPIC_MODEL_GATEWAY: 'https://gateway.example' }),
    resolveInheritedEnv: async () => ({ PATH: '/resolved/bin', HOME: '/homes/user' }),
    resolveAuthPolicy: () => AUTH_POLICY
  }
}

describe('Claude catalog availability', () => {
  it('says the CLI is missing when the resolved executable is not there', async () => {
    const folder = mkdtempSync(join(tmpdir(), 'orca-claude-missing-'))
    try {
      const missing = join(folder, 'claude with spaces', 'claude')
      const probe = createClaudeModelCatalogProbe({
        ...probeDeps(),
        resolveCommand: () => ({ command: missing, prefixArgs: [] })
      })
      await expect(probe(HOME('/homes/a'))).rejects.toMatchObject({
        unavailable: { reason: 'cliMissing' }
      })
    } finally {
      rmSync(folder, { recursive: true, force: true })
    }
  })
})

it('publishes models before settings and preserves a late sign-in response', async () => {
  const settings = Promise.withResolvers<void>()
  const signin = Promise.withResolvers<void>()
  const inventory = Promise.withResolvers<void>()
  const observations: {
    success: AgentModelCatalogSuccess
    accountKnown?: boolean
  }[] = []
  const response = (id: string, value: unknown) =>
    `${JSON.stringify({
      type: 'control_response',
      response: { subtype: 'success', request_id: id, response: value }
    })}\n`
  const probe = createClaudeModelCatalogProbe({
    ...probeDeps(),
    resolveEnv: () => ({}),
    runListing: async (launch, options) => {
      expect(
        launch.stdin
          ?.split(String.fromCharCode(10))
          .filter(Boolean)
          .map((line) => JSON.parse(line).request_id)
      ).toEqual(['orca-model-discovery', 'orca-model-settings', 'orca-signin-discovery'])
      let stdout = response('orca-model-discovery', {
        models: [{ value: 'opus', displayName: 'Opus', supportsEffort: false }]
      })
      options.onOutput?.(stdout.slice(0, 17))
      options.onOutput?.(stdout.slice(17))
      inventory.resolve()
      await settings.promise
      const settingsReply = response('orca-model-settings', {
        applied: { model: 'opus' },
        effective: {}
      })
      stdout += settingsReply
      options.onOutput?.(settingsReply)
      await signin.promise
      const signinReply = response('orca-signin-discovery', {
        account: { tokenSource: 'none', apiProvider: 'firstParty' }
      })
      stdout += signinReply
      options.onOutput?.(signinReply)
      return stdout
    }
  })
  const done = probe(HOME('/homes/a'), {
    publish: (success, accountKnown) => observations.push({ success, accountKnown })
  })
  await inventory.promise
  expect(observations[0]).toMatchObject({
    success: { models: [{ id: 'opus' }], complete: false },
    accountKnown: false
  })
  settings.resolve()
  await Promise.resolve()
  signin.resolve()
  expect(await done).toMatchObject({
    models: [{ id: 'opus' }],
    configured: { model: 'opus' },
    unavailable: { reason: 'notSignedIn' }
  })
  expect(observations.at(-1)).toMatchObject({
    accountKnown: true,
    success: { unavailable: { reason: 'notSignedIn' } }
  })
  expect(observations[0].success.configured).toBeUndefined()
})
