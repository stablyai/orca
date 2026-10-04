import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ensureStructuredAgentSessionHost,
  stopStructuredAgentSessionRuntime
} from '../runtime/structured-agent-session-runtime'
import { getStructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-registry'
import { recordingStructuredAgentSessionLogger } from '../native-chat/agent-session-wire/structured-agent-session-logger-test-support'
import {
  attachFingerprintFields,
  type AgentSessionAttachParams
} from '../native-chat/agent-session-wire/structured-agent-session-attach'
import { computeAgentSessionPayloadFingerprint } from '../../shared/agent-session-mutation-envelope'
import { DSH_ACP_PEER } from './dsh-acp-peer.test-fixture'
import type { AgentSessionRecord } from '../../shared/agent-session-record'

afterEach(stopStructuredAgentSessionRuntime)
describe('official ACP through the host journal, lease and existing status sink', () => {
  it('pins a folder and home, publishes blocked/running/done and resumes its exact provider handle', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'official-host-')))
    const cwd = join(root, 'plain-folder'),
      home = join(root, 'dsh-home'),
      command = join(root, 'dsh-fixture')
    mkdirSync(cwd)
    mkdirSync(home)
    writeFileSync(
      command,
      `#!/usr/bin/env node\nif (process.argv.includes('--version')) console.log('0.2.1-alpha.1'); else {\n${DSH_ACP_PEER}\n}`,
      { mode: 0o700 }
    )
    const publish = vi.fn(),
      forget = vi.fn(),
      logger = recordingStructuredAgentSessionLogger()
    await ensureStructuredAgentSessionHost({
      stateDirectory: root,
      hostId: 'local',
      claimKeyId: 'own-fixture-key',
      resolveWorkspacePath: async () => cwd,
      resolveDshCommand: () => command,
      resolveEnvironment: async () => process.env,
      resolveDshLaunchEnv: () => ({ DSH_HOME: home, DSH_FIXTURE_OVERRIDE: 'host-owned' }),
      resolveClaudeAuthPolicy: () => ({ stripAuthEnv: true }),
      logger: logger.logger,
      statusSink: { publish, forget }
    })
    const host = getStructuredAgentSessionHost()
    if (!host) {
      throw new Error('Host did not install')
    }
    let operations = 0
    const envelope = (method: string, fields: Record<string, unknown>, fence: number | null) => ({
      sessionId: 'official-host-session',
      clientOperationId: `${Date.now()}-${(++operations).toString(16).padStart(32, '0')}`,
      expectedRuntimeFence: fence,
      payloadFingerprint: computeAgentSessionPayloadFingerprint({
        method,
        sessionId: 'official-host-session',
        fields
      })
    })
    const params: AgentSessionAttachParams = {
      envelope: envelope('agentSession.attach', {}, null),
      location: {
        executionHostId: 'local',
        wslDistro: null,
        workspaceId: 'folder-key',
        workspaceKind: 'folder'
      },
      provider: 'dsh-acp',
      agent: 'dsh-acp',
      accountHome: { variable: 'DSH_HOME', path: home },
      runtimeKind: 'native'
    }
    params.envelope.payloadFingerprint = computeAgentSessionPayloadFingerprint({
      method: 'agentSession.attach',
      sessionId: params.envelope.sessionId,
      fields: attachFingerprintFields(params)
    })
    const attached = await host.attach({ callerKey: 'own-device' }, params)
    expect(attached).toMatchObject({ ok: true })
    if (!attached.ok) {
      throw new Error('Host refused official attachment')
    }
    let fence = attached.fence
    const body = {
      kind: 'message' as const,
      role: 'user' as const,
      blocks: [{ type: 'text' as const, text: 'fixture' }]
    }
    const send = await host.send(
      { callerKey: 'own-device' },
      {
        envelope: envelope('agentSession.send', { body }, fence),
        body
      }
    )
    expect(send).toMatchObject({ ok: true })
    await vi.waitFor(() =>
      expect(publish.mock.calls.some(([summary]) => summary.status === 'attention')).toBe(true)
    )
    expect((await host.readOptions(params.envelope.sessionId)).conversationCommands).toEqual([
      'clear'
    ])
    const record: AgentSessionRecord | null = host.deps.store.getRecord(params.envelope.sessionId)
    expect(record).toMatchObject({
      provider: 'dsh-acp',
      accountHome: { path: home },
      location: { workspaceKind: 'folder', workspaceId: 'folder-key' },
      lease: { ownerProcess: { hostId: 'local' } }
    })
    const snapshot = await host.journalSnapshot(params.envelope.sessionId)
    const approval = snapshot?.items.find((item) => item.body.kind === 'approval')
    if (!approval || !record) {
      throw new Error('Host did not journal the native permission')
    }
    fence = record.lease.runtimeFence
    const answer = {
      itemId: approval.itemId,
      expectedRevision: approval.revision,
      kind: 'approval' as const,
      optionId: 'reject-1'
    }
    await expect(
      host.respondToPrompt(
        { callerKey: 'own-device' },
        {
          envelope: envelope(
            'agentSession.respondTo:approval',
            {
              itemId: answer.itemId,
              expectedRevision: answer.expectedRevision,
              optionId: answer.optionId
            },
            fence
          ),
          ...answer
        }
      )
    ).resolves.toMatchObject({ ok: true })
    await vi.waitFor(() =>
      expect(publish.mock.calls.some(([summary]) => summary.status === 'idle')).toBe(true)
    )
    expect(
      publish.mock.calls.every(
        ([, subject]) => subject.executionHostId === 'local' && subject.workspaceId === 'folder-key'
      )
    ).toBe(true)
    expect(
      host.deps.store.getRecord(params.envelope.sessionId)?.providerHandleChain.at(-1)?.handle
    ).toEqual({ provider: 'dsh-acp', sessionId: 'fixture-session' })
    await host.close(params.envelope.sessionId, 'user-close')
    expect(host.deps.store.getRecord(params.envelope.sessionId)?.lease).toMatchObject({
      claimStatus: 'released',
      ownerProcess: null
    })
    const options = await host.readOptions(params.envelope.sessionId)
    expect(options).toMatchObject({
      models: [],
      current: { model: 'fixture-model' },
      conversationCommands: ['clear'],
      rewind: { supported: false }
    })
    const laterBody = { ...body, blocks: [{ type: 'text' as const, text: 'hold' }] }
    const laterRecord = host.deps.store.getRecord(params.envelope.sessionId)
    await expect(
      host.send(
        { callerKey: 'own-device' },
        {
          envelope: envelope(
            'agentSession.send',
            { body: laterBody },
            laterRecord?.lease.runtimeFence ?? fence
          ),
          body: laterBody
        }
      )
    ).resolves.toMatchObject({ ok: true })
    await vi.waitFor(() =>
      expect(
        host.deps.store.getRecord(params.envelope.sessionId)?.lease.ownerProcess?.pid
      ).toBeTypeOf('number')
    )
    await host.close(params.envelope.sessionId, 'user-close')
    expect(logger.entries.filter((entry) => entry.level === 'error')).toEqual([])
  })
})
