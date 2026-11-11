import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionRecord } from '../../../shared/agent-session/lifecycle/agent-session-record'
import { __setWindowsProcessTreeLoaderForTests } from '../../windows/windows-process-table'
import {
  ensureStructuredAgentSessionHost,
  stopStructuredAgentSessionRuntime
} from './structured-agent-session-runtime'
import { seedTestAgentSessionRecordStore } from './records/agent-session-record-store-test-harness'
import { nativeChatScratchFolderFor } from '../../native-chat/native-chat-scratch-folder'
import { foundAgentSessionRecord } from './records/agent-session-record-founding'
import {
  closeTestJournalHostDatabases,
  openTestJournalHostDatabase
} from '../../native-chat/agent-session-journal/store-lifecycle/journal-host-database-test-support'
import { recordingStructuredAgentSessionLogger } from '../../native-chat/agent-session-wire/host/testing/structured-agent-session-logger-test-support'
import { onStructuredAgentSessionsHeldChanged } from '../../native-chat/agent-session-wire/host/structured-agent-session-registry'

const HOST_ID = 'local'

describe('structured agent-session runtime install', () => {
  let stateDirectory: string | null = null

  afterEach(async () => {
    await stopStructuredAgentSessionRuntime()
    if (stateDirectory) {
      await closeTestJournalHostDatabases()
      await rm(stateDirectory, { recursive: true, force: true })
      stateDirectory = null
    }
    vi.restoreAllMocks()
  })

  function oldChat(provider: 'claude' | 'codex'): AgentSessionRecord {
    return foundAgentSessionRecord(
      {
        sessionId: `old-${provider}`,
        provider,
        location: {
          executionHostId: HOST_ID,
          workspaceId: 'folder-1',
          workspaceKind: 'folder',
          wslDistro: null
        },
        accountHome: {
          variable: provider === 'claude' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME',
          path: '/account'
        }
      },
      { claimKeyId: 'key-1', now: 1 }
    )
  }

  async function installOver(
    fullAccessAgents: readonly string[],
    logger = recordingStructuredAgentSessionLogger().logger
  ) {
    return await ensureStructuredAgentSessionHost({
      logger,
      stateDirectory: stateDirectory!,
      hostId: HOST_ID,
      claimKeyId: 'key-1',
      resolveWorkspacePath: async () => stateDirectory!,
      resolveLaunchArgs: () => [],
      resolveClaudeAuthPolicy: () => ({ account: 'managed' }),
      resolveAgentFullAccess: (agent) => fullAccessAgents.includes(agent),
      resolveEnvironment: async () => ({})
    })
  }

  it.each([false, true])(
    'backfills before the host is readable and keeps startup nonfatal on a failed write (%s)',
    async (failWrite) => {
      stateDirectory = await mkdtemp(join(tmpdir(), 'orca-structured-runtime-backfill-'))
      await seedTestAgentSessionRecordStore(stateDirectory, { records: [oldChat('codex')] })
      if (failWrite) {
        openTestJournalHostDatabase(stateDirectory).db.exec(
          "CREATE TRIGGER fail_permission_backfill BEFORE UPDATE ON agent_session_records BEGIN SELECT RAISE(ABORT, 'disk full'); END"
        )
      }
      const logged = recordingStructuredAgentSessionLogger()
      const host = await installOver(['codex'], logged.logger)
      expect(host.deps.store.getRecord('old-codex')?.permissionMode).toBe(
        failWrite ? undefined : 'full-access'
      )
      expect((await host.readOptions('old-codex')).current.permissionMode).toBe(
        failWrite ? 'ask' : 'full-access'
      )
      if (failWrite) {
        expect(logged.scopes()).toContain('permission-mode-backfill')
      } else {
        expect(logged.scopes()).not.toContain('permission-mode-backfill')
      }
    }
  )

  it('moves pre-rename chat visuals under the current root before the host is readable', async () => {
    stateDirectory = await mkdtemp(join(tmpdir(), 'orca-structured-runtime-visuals-'))
    await seedTestAgentSessionRecordStore(stateDirectory, { records: [oldChat('codex')] })
    const current = nativeChatScratchFolderFor(stateDirectory, 'old-codex')
    const legacy = join(stateDirectory, 'native-chat-visuals', basename(current))
    await mkdir(legacy, { recursive: true })
    await writeFile(join(legacy, 'chart.html'), '<p>chart</p>')

    let readableAtPublication = false
    const stopListening = onStructuredAgentSessionsHeldChanged((held) => {
      if (held) {
        readableAtPublication = readFileSync(join(current, 'chart.html'), 'utf8') === '<p>chart</p>'
      }
    })
    try {
      await installOver([])
    } finally {
      stopListening()
    }

    expect(readableAtPublication).toBe(true)
    expect(await readFile(join(current, 'chart.html'), 'utf8')).toBe('<p>chart</p>')
  })
})
