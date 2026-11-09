import { describe, expect, it, vi } from 'vitest'
import {
  classifyAgentStatusOutput,
  HostAgentSignInStatusChecker,
  type HostAgentSignInStatusDeps
} from './host-agent-sign-in-status'

const CLAUDE_SIGNED_OUT = '{\n  "loggedIn": false,\n  "authMethod": "none"\n}\n'
const CLAUDE_API_KEY =
  '{\n  "loggedIn": true,\n  "authMethod": "api_key",\n  "apiKeySource": "ANTHROPIC_API_KEY"\n}\n'
const CLAUDE_SUBSCRIPTION = '{ "loggedIn": true, "authMethod": "claude.ai" }'

function emptyAccounts(): NonNullable<ReturnType<HostAgentSignInStatusDeps['readAccounts']>> {
  return {
    claude: { accounts: [], activeAccountId: null },
    codex: { accounts: [], activeAccountId: null }
  }
}

describe('classifyAgentStatusOutput', () => {
  it('reads claude auth status, which exits 1 with its JSON when signed out', () => {
    expect(
      classifyAgentStatusOutput('claude', {
        exitCode: 1,
        output: CLAUDE_SIGNED_OUT,
        timedOut: false
      })
    ).toEqual({ agent: 'claude', state: 'signedOut' })
    expect(
      classifyAgentStatusOutput('claude', { exitCode: 0, output: CLAUDE_API_KEY, timedOut: false })
    ).toEqual({ agent: 'claude', state: 'signedIn', method: 'apiKey' })
    expect(
      classifyAgentStatusOutput('claude', {
        exitCode: 0,
        output: CLAUDE_SUBSCRIPTION,
        timedOut: false
      })
    ).toEqual({ agent: 'claude', state: 'signedIn', method: 'cliLogin' })
  })

  it('reports an old claude without --json as unknown rather than signed out', () => {
    expect(
      classifyAgentStatusOutput('claude', {
        exitCode: 1,
        output: "error: unknown option '--json'",
        timedOut: false
      })
    ).toEqual({ agent: 'claude', state: 'unknown' })
  })

  it('reads codex login status by exit code', () => {
    expect(
      classifyAgentStatusOutput('codex', {
        exitCode: 0,
        output: '\nLogged in using ChatGPT',
        timedOut: false
      })
    ).toEqual({ agent: 'codex', state: 'signedIn', method: 'cliLogin' })
    expect(
      classifyAgentStatusOutput('codex', {
        exitCode: 0,
        output: 'Logged in using an API key - sk-***',
        timedOut: false
      })
    ).toEqual({ agent: 'codex', state: 'signedIn', method: 'apiKey' })
    expect(
      classifyAgentStatusOutput('codex', { exitCode: 1, output: 'Not logged in', timedOut: false })
    ).toEqual({ agent: 'codex', state: 'signedOut' })
    expect(
      classifyAgentStatusOutput('codex', { exitCode: null, output: '', timedOut: true })
    ).toEqual({ agent: 'codex', state: 'unknown' })
  })
})

describe('HostAgentSignInStatusChecker', () => {
  it('reports a selected Orca account as signed in and a missing CLI as not installed', async () => {
    const accounts = emptyAccounts()
    accounts.codex = {
      accounts: [
        {
          id: 'codex-1',
          email: 'a@example.com',
          createdAt: 1,
          updatedAt: 1,
          lastAuthenticatedAt: 1
        }
      ],
      activeAccountId: 'codex-1'
    }
    const runStatus = vi.fn<HostAgentSignInStatusDeps['runStatus']>()
    const checker = new HostAgentSignInStatusChecker({
      findCommand: async (command) =>
        command === 'codex' ? { status: 'available', binary: '/bin/codex' } : { status: 'absent' },
      runStatus,
      readAccounts: () => accounts,
      now: () => 1_000
    })
    await expect(checker.read()).resolves.toEqual({
      checkedAt: 1_000,
      agents: [
        { agent: 'claude', state: 'notInstalled' },
        { agent: 'codex', state: 'signedIn', method: 'orcaAccount' }
      ]
    })
    expect(runStatus).not.toHaveBeenCalled()
  })

  it('reports a selected Claude account without a login as signed out, even when the CLI is signed in', async () => {
    const accounts = emptyAccounts()
    accounts.claude = {
      accounts: [
        {
          id: 'claude-1',
          email: 'a@example.com',
          authMethod: 'subscription-oauth',
          createdAt: 1,
          updatedAt: 1,
          lastAuthenticatedAt: 1,
          needsSignIn: true
        }
      ],
      activeAccountId: 'claude-1'
    }
    const checker = new HostAgentSignInStatusChecker({
      findCommand: async (command) => ({ status: 'available', binary: `/bin/${command}` }),
      runStatus: async (binary) =>
        binary === '/bin/claude'
          ? { exitCode: 0, output: CLAUDE_SUBSCRIPTION, timedOut: false }
          : { exitCode: 1, output: 'Not logged in', timedOut: false },
      readAccounts: () => accounts,
      now: () => 5
    })
    const report = await checker.read()
    expect(report.agents).toEqual([
      { agent: 'claude', state: 'signedOut' },
      { agent: 'codex', state: 'signedOut' }
    ])
  })

  it('answers a forced recheck with a fresh check, not one begun before the sign-in', async () => {
    let calls = 0
    const firstCheck = Promise.withResolvers<void>()
    const checker = new HostAgentSignInStatusChecker({
      findCommand: async (command) =>
        command === 'codex' ? { status: 'available', binary: '/bin/codex' } : { status: 'absent' },
      runStatus: async () => {
        // The first check started before the sign-in finished.
        const signedIn = calls++ > 0
        if (!signedIn) {
          await firstCheck.promise
        }
        return signedIn
          ? { exitCode: 0, output: 'Logged in using ChatGPT', timedOut: false }
          : { exitCode: 1, output: 'Not logged in', timedOut: false }
      },
      readAccounts: () => emptyAccounts(),
      now: () => 1
    })
    const before = checker.read()
    const after = checker.read(true)
    firstCheck.resolve()
    expect((await before).agents[1]).toEqual({ agent: 'codex', state: 'signedOut' })
    expect((await after).agents[1]).toEqual({
      agent: 'codex',
      state: 'signedIn',
      method: 'cliLogin'
    })
  })
})
