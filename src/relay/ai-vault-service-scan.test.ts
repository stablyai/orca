import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cursorBucketForCwd } from '../main/ai-vault/session-scanner-cursor-paths'
import { getRemoteHostPlatform } from '../main/ssh/ssh-remote-platform'
import { restampAiVaultListResult } from '../main/ai-vault/session-list-results'
import { createRelayAiVaultFilesystemProvider } from './ai-vault-service-filesystem'
import { scanRelayAiVaultSessions } from './ai-vault-service-scan'

const tempRoots: string[] = []

afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('relay AI Vault owning-host scan', () => {
  it('discovers Cursor sidecars from the remote home and stamps the SSH host', async () => {
    const remoteHome = await mkdtemp(join(tmpdir(), 'orca-relay-cursor-sidecar-'))
    tempRoots.push(remoteHome)
    const workspace = join(remoteHome, 'workspace')
    const sessionId = 'relay-sidecar-session'
    const sessionDir = join(
      remoteHome,
      '.cursor',
      'chats',
      cursorBucketForCwd(workspace, 'linux'),
      sessionId
    )
    await Promise.all([mkdir(workspace), mkdir(sessionDir, { recursive: true })])
    await Promise.all([
      writeFile(
        join(sessionDir, 'meta.json'),
        JSON.stringify({
          createdAtMs: 1_750_000_000_000,
          updatedAtMs: 1_750_000_001_000,
          hasConversation: true,
          title: 'Relay Cursor sidecar',
          cwd: workspace
        })
      ),
      writeFile(join(sessionDir, 'store.db'), '')
    ])
    vi.stubEnv('XDG_CONFIG_HOME', join(remoteHome, 'wrong-local-config'))

    const result = restampAiVaultListResult(
      await scanRelayAiVaultSessions({
        provider: createRelayAiVaultFilesystemProvider(),
        remoteHome,
        hostPlatform: getRemoteHostPlatform('linux-x64'),
        limit: 10
      }),
      'ssh:dev-box'
    )

    expect(result.issues).toEqual([])
    expect(result.sessions).toHaveLength(1)
    expect(result.sessions[0]).toMatchObject({
      executionHostId: 'ssh:dev-box',
      agent: 'cursor',
      sessionId,
      title: 'Relay Cursor sidecar',
      cwd: workspace,
      filePath: join(sessionDir, 'meta.json'),
      messageCount: 1,
      hasConversation: true
    })
  })

  it('reports an unavailable remote Cursor root', async () => {
    const remoteHome = await mkdtemp(join(tmpdir(), 'orca-relay-cursor-missing-'))
    tempRoots.push(remoteHome)

    const result = await scanRelayAiVaultSessions({
      provider: createRelayAiVaultFilesystemProvider(),
      remoteHome,
      hostPlatform: getRemoteHostPlatform('linux-x64'),
      limit: 10
    })

    expect(result.sessions).toEqual([])
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        agent: 'cursor',
        path: join(remoteHome, '.cursor', 'chats'),
        message: 'Cursor sidecar root could not be resolved.'
      })
    )
  })

  it('prioritizes scoped Cursor sessions without exceeding the relay limit', async () => {
    const remoteHome = await mkdtemp(join(tmpdir(), 'orca-relay-cursor-limit-'))
    tempRoots.push(remoteHome)
    const scopedWorkspace = join(remoteHome, 'scoped-workspace')
    const recentWorkspace = join(remoteHome, 'recent-workspace')
    const scopedSession = join(
      remoteHome,
      '.cursor',
      'chats',
      cursorBucketForCwd(scopedWorkspace, 'linux'),
      'scoped-session'
    )
    const recentSession = join(
      remoteHome,
      '.cursor',
      'chats',
      cursorBucketForCwd(recentWorkspace, 'linux'),
      'recent-session'
    )
    await Promise.all([
      mkdir(scopedWorkspace),
      mkdir(recentWorkspace),
      mkdir(scopedSession, { recursive: true }),
      mkdir(recentSession, { recursive: true })
    ])
    await Promise.all([
      writeFile(
        join(scopedSession, 'meta.json'),
        JSON.stringify({
          createdAtMs: 1,
          updatedAtMs: 1,
          hasConversation: true,
          title: 'Scoped session',
          cwd: scopedWorkspace
        })
      ),
      writeFile(join(scopedSession, 'store.db'), ''),
      writeFile(
        join(recentSession, 'meta.json'),
        JSON.stringify({
          createdAtMs: 2,
          updatedAtMs: 2,
          hasConversation: true,
          title: 'Recent session',
          cwd: recentWorkspace
        })
      ),
      writeFile(join(recentSession, 'store.db'), '')
    ])

    const result = await scanRelayAiVaultSessions({
      provider: createRelayAiVaultFilesystemProvider(),
      remoteHome,
      hostPlatform: getRemoteHostPlatform('linux-x64'),
      limit: 1,
      scopePaths: [scopedWorkspace]
    })

    expect(result.sessions).toHaveLength(1)
    expect(result.sessions[0]).toMatchObject({ sessionId: 'scoped-session' })
  })
})
