import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { resolveCodexCommand } from '../../codex-cli/command'
import { CodexStructuredSessionAdapter } from '../../codex/codex-structured-session-adapter'
import { createCodexStructuredLaunchResolver } from '../../codex/codex-structured-launch-resolution'
import { openTestAgentSessionRecordStore } from '../agent-session-record-store-test-harness'
import { openTestJournalHostDatabase } from '../../native-chat/agent-session-journal/journal-host-database-test-support'
import { createStructuredAgentSessionLogger } from '../../native-chat/agent-session-wire/structured-agent-session-logger'
import { StructuredAgentSessionHost } from '../../native-chat/agent-session-wire/structured-agent-session-host'
import { setStructuredAgentSessionHost } from '../../native-chat/agent-session-wire/structured-agent-session-registry'
import { hostTestAttachParams } from '../../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import { MachineRoomHarnessAdapter } from './machine-harness-adapter'
import { roomHarnessRuntimeFixture } from './room-harness-runtime.test-fixture'
import { structuredRoomCaller, structuredRoomMutationEnvelope } from './machine-harness-session'

const command = resolveCodexCommand()
const realCodexTest = spawnSync(command, ['--version']).status === 0 ? it : it.skip

realCodexTest(
  'restores an empty room with real Codex, then preserves the thread after first input',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-empty-codex-live-'))
    const account = join(root, 'codex-home')
    const cwd = join(root, 'workspace')
    await mkdir(account)
    await mkdir(cwd)
    await writeFile(
      join(account, 'config.toml'),
      [
        'model_provider = "orca-integration"',
        'model = "gpt-5"',
        '[model_providers.orca-integration]',
        'name = "Orca integration"',
        'base_url = "http://127.0.0.1:9/v1"',
        'wire_api = "responses"',
        'requires_openai_auth = false',
        `[projects.${JSON.stringify(cwd)}]`,
        'trust_level = "trusted"'
      ].join('\n')
    )
    const store = await openTestAgentSessionRecordStore(root)
    const codex = new CodexStructuredSessionAdapter({
      resolveLaunch: createCodexStructuredLaunchResolver({
        store,
        resolveWorkspacePath: async () => cwd,
        resolveCommand: () => command
      })
    })
    const host = new StructuredAgentSessionHost({
      store,
      adapter: codex,
      journalDatabase: openTestJournalHostDatabase(root),
      logger: createStructuredAgentSessionLogger(),
      claimKeyId: 'test-key'
    })
    setStructuredAgentSessionHost(host)
    const runtime = roomHarnessRuntimeFixture({
      ensureStructuredAgentSessionHost: async () => undefined,
      resolveStructuredAgentSessionCreateIntent: async (input) =>
        hostTestAttachParams(null, {
          envelope: { ...input.envelope, expectedRuntimeFence: null, payloadFingerprint: '' },
          providerHandle: undefined,
          accountHome: { variable: 'CODEX_HOME', path: account },
          location: {
            executionHostId: 'local',
            wslDistro: null,
            workspaceId: 'workspace-1',
            workspaceKind: 'folder'
          }
        })
    })
    const rooms = new MachineRoomHarnessAdapter('codex', runtime)
    try {
      const original = await rooms.launch('workspace-1')
      const available = await host.readOptions(original.conversationId)
      const model = available.models.find((entry) => entry.efforts.length > 0)!
      expect(model).toBeDefined()
      const options = { model: model.id, effort: model.efforts[0].value, fastMode: 'false' }
      for (const [key, value] of Object.entries(options)) {
        const result = await host.setOption(structuredRoomCaller(original), {
          envelope: await structuredRoomMutationEnvelope(
            original.conversationId,
            'agentSession.setOption',
            { key, value }
          ),
          key,
          value
        })
        expect(result, JSON.stringify({ key, result })).toMatchObject({ ok: true })
      }
      const oldChain = store.getRecord(original.conversationId)!.providerHandleChain
      const savedOptions = store.getRecord(original.conversationId)!.options
      await host.flushStreamedEvents(original.conversationId)
      await host.close(original.conversationId, 'evict')
      expect(store.getRecord(original.conversationId)?.lease).toMatchObject({
        claimStatus: 'released',
        handoffStage: null,
        unreconciled: false
      })
      let restored = await rooms.restore(original)
      expect(restored.conversationId).toBe(original.conversationId)
      expect(store.getRecord(original.conversationId)!.providerHandleChain).toEqual(oldChain)
      expect(store.getRecord(restored.conversationId)).toMatchObject({
        accountHome: { path: account },
        options
      })
      expect(host.hasProviderChild(restored.conversationId)).toBe(false)
      const emptyId = restored.conversationId
      await host.close(emptyId, 'evict')
      restored = await rooms.connectExisting({ worktreeId: 'workspace-1', conversationId: emptyId })
      expect(restored.conversationId).toBe(emptyId)
      expect(store.getRecord(restored.conversationId)).toMatchObject({
        accountHome: { path: account },
        options
      })
      expect(await rooms.send(restored, 'isolated test input')).toMatchObject({ accepted: true })
      await vi.waitFor(() => expect(host.hasProviderChild(restored.conversationId)).toBe(true))
      await host.flushStreamedEvents(restored.conversationId)
      await host.close(restored.conversationId, 'evict')
      expect((await rooms.restore(restored)).conversationId).toBe(restored.conversationId)
      expect(store.getRecord(restored.conversationId)!.options).toEqual(savedOptions)
    } finally {
      for (const session of host.listSessionTabs()) {
        await host.close(session.sessionId, 'evict')
      }
      await codex.closeAll()
      await host.flushAllStreamedEvents()
      setStructuredAgentSessionHost(null)
      await rm(root, { recursive: true, force: true })
    }
  },
  60_000
)
