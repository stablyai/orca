import { expect, it, vi } from 'vitest'
import { agentSessionRecordFixture } from '../../../../shared/agent-session/lifecycle/records/agent-session-record.test-fixture'
import type { AgentSessionRecord } from '../../../../shared/agent-session/lifecycle/agent-session-record'
import { codexProviderHandle } from '../../../../shared/agent-session/lifecycle/provider-handles/agent-session-provider-handle-encoding'
import {
  createCodexStructuredLaunchResolver,
  TEST_SPAWN_TOKEN
} from '../../../runtime/agent-session/launch/structured-agent-launch-composition.test-support'
import { identityFor } from '../session-lifecycle/codex-structured-session-adapter-fixture'

it('replaces a chat-created thread only when the chat never exchanged a turn on it', async () => {
  const record: AgentSessionRecord = {
    ...agentSessionRecordFixture(),
    provider: 'codex',
    accountHome: { variable: 'CODEX_HOME', path: '/account' },
    providerHandleChain: [
      {
        linkId: 'link',
        handle: codexProviderHandle('thread-created'),
        origin: 'created',
        mintedAtFence: 1,
        observedAt: 1
      }
    ]
  }
  const launchWith = (exchanged: boolean) =>
    createCodexStructuredLaunchResolver({
      store: { getRecord: () => record, pinLaunchDirectory: vi.fn() },
      resolveCommand: () => ({ command: 'codex', prefixArgs: [] }),
      resolveEnvironment: async () => ({}),
      resolveLaunchArgs: () => [],
      resolveWorkspacePath: async () => '/folder',
      savedSession: { hasProviderTurn: async () => exchanged }
    })({ identity: identityFor(record.sessionId), spawnToken: TEST_SPAWN_TOKEN })

  expect(await launchWith(false)).toMatchObject({
    resumeThreadId: 'thread-created',
    supersedeIfUnsaved: true
  })
  const saved = await launchWith(true)
  expect(saved).toMatchObject({ resumeThreadId: 'thread-created' })
  expect(saved).not.toHaveProperty('supersedeIfUnsaved')
})
