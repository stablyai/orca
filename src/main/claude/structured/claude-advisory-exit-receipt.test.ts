import { expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ClaudeStructuredSessionAdapter } from './claude-structured-session-adapter'
import {
  fakeClaude,
  identityFor,
  recordingJournalSink,
  PROVIDER_SESSION_ID
} from './claude-structured-session-test-support'
import { claudeStartupSettled } from './claude-structured-startup-settled-test-support'
import { eventually } from '../../native-chat/agent-session-wire/host/testing/structured-agent-session-queued-message-rig-provider.test-fixture'
import { agentSessionAdvisoryPolicyFingerprint } from '../../../shared/agent-session/agent-session-advisory-policy'
import type {
  AgentSessionAdvisoryObservation,
  AgentSessionAdvisoryReceiptWrite
} from '../../../shared/agent-session/agent-session-advisory-receipt'

it('retains final advisory cleanup after unexpected exit without retaining report authority', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'orca-advisory-exit-'))
  const claude = fakeClaude()
  const writes: AgentSessionAdvisoryReceiptWrite[] = []
  let reportGeneration: (() => string | null) | undefined
  const policy = {
    schema: 2 as const,
    dataScope: 'published' as const,
    sourcePin: 'a'.repeat(40),
    deadlineAt: Date.now() + 120000,
    maxModelCalls: 4,
    binding: {
      accountFingerprint: `claude:${'b'.repeat(64)}`,
      model: 'fixture',
      effort: 'high' as const
    },
    artifacts: [
      {
        path: 'note',
        text: 'hello',
        sha256: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824'
      }
    ]
  }
  const adapter = new ClaudeStructuredSessionAdapter({
    resolveLaunch: async () => ({
      pathToClaudeCodeExecutable: 'fixture',
      options: { model: 'fixture', effort: 'high' },
      cwd,
      claudeConfigDir: '/fixture/account',
      providerSessionId: PROVIDER_SESSION_ID,
      resumeLeafUuid: null,
      resumesTranscript: false,
      cliFlag: async () => 'supported',
      continuesChain: false,
      advisoryPolicy: policy
    }),
    onEvent: () => {},
    openConnection: claude.openConnection,
    persistHandle: async () => {},
    readProcessStartTime: async () => 1700000000000,
    onAdvisoryReceipt: async (input) => {
      writes.push(structuredClone(input))
    },
    prepareAdvisoryReporter: (input) => {
      reportGeneration = input.currentGeneration
      return async () => {}
    }
  })
  try {
    await adapter.acquire({
      identity: identityFor(),
      fence: 7,
      spawnToken: 'owned-spawn',
      events: recordingJournalSink()
    })
    await claudeStartupSettled(adapter, 'session-1')
    const connection = claude.connections[0]!
    const observation: AgentSessionAdvisoryObservation = {
      version: 1,
      invalidated: true,
      turnCompleted: false,
      execution: {
        agent: 'claude',
        observedAt: Date.now(),
        binding: null,
        bounded: {
          policyFingerprint: agentSessionAdvisoryPolicyFingerprint(policy),
          deadlineAt: policy.deadlineAt,
          maxModelCalls: 4,
          modelCalls: 0,
          inputAdmitted: false,
          hooksApplied: false,
          callCounter: 'main-assistant-message-ids'
        }
      },
      closure: { root: 'exited', tree: 'unverifiable', observedAt: Date.now() }
    }
    connection.handlers.onAdvisoryObservation?.(observation)
    const close = connection.close
    connection.close = async () => {
      connection.handlers.onAdvisoryObservation?.({
        ...observation,
        closure: { root: 'exited', tree: 'exited', observedAt: Date.now() }
      })
      return close()
    }
    connection.handlers.onExit?.(new Error('fixture unexpected exit'), { expected: false })
    await eventually(() =>
      expect(writes.at(-1)?.receipt.closure).toMatchObject({ root: 'exited', tree: 'exited' })
    )
    expect(writes.at(-1)?.generation).toBe(writes[0]?.generation)
    expect(reportGeneration?.()).toBeNull()
  } finally {
    await adapter.closeAll()
    claude.dispose()
    await rm(cwd, { recursive: true, force: true })
  }
})
