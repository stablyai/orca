import { describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentMessageSource } from '../../shared/agent-session-message-source'
import { AgentSessionAttachmentStore } from '../native-chat/agent-session-attachments/agent-session-attachment-store'
import { setAgentSessionAttachmentStore } from '../native-chat/agent-session-attachments/agent-session-attachment-store-registry'
import { nativeChatTranscriptIncludesPath } from '../native-chat/native-chat-file-provenance'
import {
  createRuntimeFileCommands,
  useRuntimeFileCommandsLifecycle
} from './orca-runtime-files-test-harness'
import {
  absoluteFileTarget,
  useTerminalArtifactTempFiles
} from './orca-runtime-files-terminal-artifact-fixtures'

vi.mock('fs', async () => (await import('./orca-runtime-files-mock-registry')).fsModuleMock())
vi.mock('fs/promises', async () =>
  (await import('./orca-runtime-files-mock-registry')).fsPromisesModuleMock()
)
vi.mock(
  './file-watcher-host',
  async () => (await import('./orca-runtime-files-mock-registry')).fileWatcherHostMock
)
vi.mock('../ipc/filesystem-auth', async () =>
  (await import('./orca-runtime-files-mock-registry')).filesystemAuthModuleMock()
)
vi.mock('../git/runner', async () =>
  (await import('./orca-runtime-files-mock-registry')).gitRunnerModuleMock()
)
vi.mock(
  '../ipc/local-worktree-runtime-options',
  async () => (await import('./orca-runtime-files-mock-registry')).localWorktreeRuntimeOptionsMock
)

describe('RuntimeFileCommands user attachment grants', () => {
  useRuntimeFileCommandsLifecycle()
  const { tempDirs } = useTerminalArtifactTempFiles()
  it('opens a user attachment through a client-bound read-only grant', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-attachment-grant-'))
    tempDirs.push(root)
    const storeRoot = join(root, 'agent-session-attachments')
    const upload = join(storeRoot, '65d59a56-046d-4f2e-8001-325c612d2ab5')
    await mkdir(upload, { recursive: true })
    const file = join(upload, 'report.txt')
    await writeFile(file, 'Report')
    const context = { tabId: 'chat-tab', sessionId: 'chat-session' }
    let from: AgentMessageSource | undefined
    const { commands } = createRuntimeFileCommands({
      path: '/repo',
      hasRecentNativeChatOutputPath: vi.fn((_worktreeId, ctx, pathText, absolutePath) =>
        nativeChatTranscriptIncludesPath({
          tabs: [
            {
              type: 'agent-session',
              id: 'chat-tab',
              sessionId: 'chat-session',
              title: 'Chat',
              agent: 'codex',
              isActive: true
            }
          ],
          context: ctx,
          pathText,
          absolutePath,
          readJournal: async () => ({
            items: [
              {
                itemId: 'user-1',
                revision: 1,
                sequence: 1,
                observedAt: 1,
                body: {
                  kind: 'message',
                  role: 'user',
                  blocks: [{ type: 'text', text: `@${file}` }],
                  from
                }
              }
            ]
          })
        })
      )
    })
    setAgentSessionAttachmentStore(
      new AgentSessionAttachmentStore(storeRoot, { hasSession: () => true })
    )
    try {
      from = { kind: 'agent', senders: [], orchestration: null }
      const refused = await commands.resolveTerminalPath(
        'id:wt-1',
        file,
        null,
        'client-a',
        null,
        true,
        context
      )
      expect(refused.exists).toBe(false)
      expect(refused.openTarget).toBeUndefined()
      from = undefined
      const resolved = await commands.resolveTerminalPath(
        'id:wt-1',
        file,
        null,
        'client-a',
        null,
        true,
        context
      )
      const target = absoluteFileTarget(resolved)
      await expect(
        commands.readTerminalArtifactFile(
          'id:wt-1',
          target.grantId,
          target.absolutePath,
          'client-a'
        )
      ).resolves.toMatchObject({ content: 'Report' })
      await expect(
        commands.readTerminalArtifactFile(
          'id:wt-1',
          target.grantId,
          target.absolutePath,
          'client-b'
        )
      ).rejects.toThrow('terminal_file_grant_mismatch')
      await expect(
        commands.writeTerminalArtifactFile(
          'id:wt-1',
          target.grantId,
          target.absolutePath,
          'Changed',
          'client-a'
        )
      ).rejects.toThrow('terminal_file_grant_read_only')
    } finally {
      setAgentSessionAttachmentStore(null)
    }
  })

  it.skipIf(process.platform === 'win32')(
    'refuses a user-attachment file symlink outside its store',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'orca-attachment-symlink-'))
      tempDirs.push(root)
      const storeRoot = join(root, 'agent-session-attachments')
      const upload = join(storeRoot, '65d59a56-046d-4f2e-8001-325c612d2ab5')
      await mkdir(upload, { recursive: true })
      const secret = join(root, 'secret.txt')
      await writeFile(secret, 'Secret')
      const file = join(upload, 'report.txt')
      await symlink(secret, file)
      const { commands } = createRuntimeFileCommands({
        path: '/repo',
        hasRecentNativeChatOutputPath: vi.fn(() => true)
      })
      setAgentSessionAttachmentStore(
        new AgentSessionAttachmentStore(storeRoot, { hasSession: () => true })
      )
      try {
        await expect(
          commands.resolveTerminalPath('id:wt-1', file, null, 'client-a', null, true, {
            tabId: 'chat-tab',
            sessionId: 'chat-session'
          })
        ).rejects.toThrow('attachment_path_unauthorized')
      } finally {
        setAgentSessionAttachmentStore(null)
      }
    }
  )
})
