import { describe, expect, it } from 'vitest'
import { getRemoteHostPlatform } from '../ssh/ssh-remote-platform'
import { scanRemoteAiVaultSessions } from './remote-session-scanner'
import { MemoryRemoteProvider, jsonLines } from './remote-session-scanner-memory-provider'
import { cursorBucketForCwd, cursorLegacySlug } from './session-scanner-cursor-paths'

describe('scanRemoteAiVaultSessions Cursor sidecars', () => {
  it('reconciles one bounded SSH sidecar scan with its legacy transcript', async () => {
    const provider = new MemoryRemoteProvider()
    const cwd = '/home/ada/repo'
    const sessionId = 'cursor-session'
    const bucket = cursorBucketForCwd(cwd, 'linux')
    const metaPath = `/home/ada/.cursor/chats/${bucket}/${sessionId}/meta.json`
    const sidecarContent = JSON.stringify({
      createdAtMs: 1_750_000_000_000,
      hasConversation: true,
      title: 'Remote Cursor'
    })
    const transcriptPath =
      `/home/ada/.cursor/projects/${cursorLegacySlug(cwd)}` +
      `/agent-transcripts/${sessionId}/${sessionId}.jsonl`
    provider.cursorScanResponse = {
      version: 1,
      scopeCwds: [cwd],
      sidecars: [
        {
          bucket,
          sessionId,
          metaPath,
          content: sidecarContent,
          metaMtimeMs: 1_750_000_000_100,
          metaSizeBytes: 100,
          storeMtimeMs: 1_750_000_000_200,
          scopeCwd: cwd
        }
      ],
      issues: [],
      counters: {
        rootReaddir: 1,
        bucketReaddir: 1,
        fileLstat: 2,
        boundedReads: 1,
        scopeRealpath: 1,
        returnedBytes: Buffer.byteLength(sidecarContent),
        elapsedMs: 1
      },
      truncated: {
        scopePaths: false,
        buckets: false,
        sessionDirs: false,
        sidecarBytes: false
      }
    }
    provider.addFile(
      transcriptPath,
      jsonLines([
        {
          role: 'user',
          message: { content: [{ type: 'text', text: 'Legacy preview' }] }
        }
      ]),
      1_750_000_000_300
    )

    const result = await scanRemoteAiVaultSessions({
      provider,
      executionHostId: 'ssh:dev-box',
      remoteHome: '/home/ada',
      hostPlatform: getRemoteHostPlatform('linux-x64'),
      scopePaths: [cwd]
    })

    expect(provider.cursorScanCalls).toBe(1)
    expect(provider.readFilePaths).not.toContain(metaPath)
    expect(result.sessions).toHaveLength(1)
    expect(result.sessions[0]).toMatchObject({
      id: 'ssh:dev-box:cursor:cursor-session',
      cwd,
      filePath: metaPath,
      transcriptFilePath: transcriptPath,
      hasConversation: true
    })
  })

  it('rejects relay scope cwd evidence that does not hash to the returned bucket', async () => {
    const provider = new MemoryRemoteProvider()
    const content = JSON.stringify({
      createdAtMs: 1_750_000_000_000,
      hasConversation: true
    })
    provider.cursorScanResponse = {
      version: 1,
      scopeCwds: ['/home/ada/wrong'],
      sidecars: [
        {
          bucket: '11111111111111111111111111111111',
          sessionId: 'mismatched-scope',
          metaPath:
            '/home/ada/.cursor/chats/11111111111111111111111111111111/mismatched-scope/meta.json',
          content,
          metaMtimeMs: 1_750_000_000_100,
          metaSizeBytes: Buffer.byteLength(content),
          storeMtimeMs: 1_750_000_000_200,
          scopeCwd: '/home/ada/wrong'
        }
      ],
      issues: [],
      counters: {
        rootReaddir: 1,
        bucketReaddir: 1,
        fileLstat: 2,
        boundedReads: 1,
        scopeRealpath: 1,
        returnedBytes: Buffer.byteLength(content),
        elapsedMs: 1
      },
      truncated: {
        scopePaths: false,
        buckets: false,
        sessionDirs: false,
        sidecarBytes: false
      }
    }

    const result = await scanRemoteAiVaultSessions({
      provider,
      executionHostId: 'ssh:dev-box',
      remoteHome: '/home/ada',
      hostPlatform: getRemoteHostPlatform('linux-x64'),
      scopePaths: ['/home/ada/wrong']
    })

    expect(result.sessions[0]?.cwd).toBeNull()
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        executionHostId: 'ssh:dev-box',
        message: 'Cursor scope metadata does not match its storage bucket.'
      })
    )
  })
})
