import { describe, expect, it, vi } from 'vitest'
import { writeFile } from 'node:fs/promises'
import { filesystemPathToFileUri } from '../../shared/file-uri-path'
import { isWindowsAbsolutePathLike } from '../../shared/cross-platform-path'
import { nativeChatTranscriptIncludesPath } from '../native-chat/native-chat-file-provenance'
import {
  createRuntimeFileCommands,
  useRuntimeFileCommandsLifecycle
} from './orca-runtime-files-test-harness'
import {
  absoluteFileTarget,
  useTerminalArtifactTempFiles
} from './orca-runtime-files-terminal-artifact-fixtures'
import type { NativeChatBlock } from '../../shared/native-chat-types'
import type { RuntimeNativeChatFileContext } from '../../shared/runtime-types'

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

describe('chat artifacts authorized by their actual host Markdown', () => {
  useRuntimeFileCommandsLifecycle()
  const { tempFile } = useTerminalArtifactTempFiles()

  const artifacts = [
    [
      'png',
      Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aM1sAAAAASUVORK5CYII=',
        'base64'
      )
    ],
    ['pdf', Buffer.from('%PDF-1.4\n%%EOF')],
    ['svg', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>')],
    ['csv', Buffer.from('round,score\n1,97.1\n')]
  ] as const
  it.each(
    artifacts.flatMap(([extension, bytes]) =>
      ['agent-session:session-1', 'structured-agent-session-session-1'].flatMap((tabId) =>
        ['markdown', 'image-ref'].map((referenceKind) => ({
          extension,
          bytes,
          tabId,
          referenceKind
        }))
      )
    )
  )(
    '$extension $referenceKind grants and exact reads from $tabId',
    async ({ extension, bytes, tabId, referenceKind }) => {
      const file = (await tempFile(`result.${extension}`, '')).replaceAll('\\', '/')
      // Sandbox addresses POSIX hosts; native Windows fixtures use the existing file URI route.
      const reference = isWindowsAbsolutePathLike(file)
        ? filesystemPathToFileUri(file)
        : `sandbox:${encodeURI(file)}`
      await writeFile(file, bytes)
      const blocks: NativeChatBlock[] =
        referenceKind === 'markdown'
          ? [{ type: 'text', text: `![Result](${reference})` }]
          : [{ type: 'image-ref', path: file }]
      const context = { tabId, sessionId: 'session-1' }
      const { commands } = createRuntimeFileCommands({
        path: '/repo',
        hasRecentNativeChatOutputPath: vi.fn(
          (
            _worktree: string,
            requested: RuntimeNativeChatFileContext,
            pathText: string,
            absolutePath: string
          ) =>
            nativeChatTranscriptIncludesPath({
              tabs: [
                {
                  type: 'agent-session',
                  id: 'agent-session:session-1',
                  sessionId: 'session-1',
                  agent: 'codex',
                  title: 'Chat',
                  isActive: true
                }
              ],
              context: requested,
              pathText,
              absolutePath,
              readStructuredMessages: async () => [
                {
                  role: 'assistant',
                  blocks
                }
              ]
            })
        )
      })
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
      const preview = await commands.readTerminalArtifactPreview(
        'id:wt-1',
        target.grantId,
        target.absolutePath,
        'client-a'
      )
      expect(Buffer.from(preview.content, preview.isBinary ? 'base64' : 'utf8')).toEqual(bytes)
      await expect(
        commands.readTerminalArtifactPreview(
          'id:wt-1',
          target.grantId,
          target.absolutePath,
          'client-b'
        )
      ).rejects.toThrow('terminal_file_grant_mismatch')
      const forged = await commands.resolveTerminalPath(
        'id:wt-1',
        file,
        null,
        'client-a',
        null,
        true,
        { tabId, sessionId: 'another-session' }
      )
      expect(forged.openTarget).toBeUndefined()
      const wrongTab = await commands.resolveTerminalPath(
        'id:wt-1',
        file,
        null,
        'client-a',
        null,
        true,
        { tabId: 'structured-agent-session-another-session', sessionId: context.sessionId }
      )
      expect(wrongTab.openTarget).toBeUndefined()
    }
  )
})
