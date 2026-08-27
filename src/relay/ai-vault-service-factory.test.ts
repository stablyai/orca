import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AiVaultServiceTestChild,
  readyAiVaultServiceChild
} from '../main/ai-vault/session-scanner-service-test-child'
import { getRemoteHostPlatform } from '../main/ssh/ssh-remote-platform'

const spawnMock = vi.hoisted(() => vi.fn())

vi.mock('./ai-vault-service-spawn', () => ({ spawnRelayAiVaultService: spawnMock }))

const { createRelayAiVaultService } = await import('./ai-vault-service-factory')

async function captureInit(baseEnv: NodeJS.ProcessEnv): Promise<unknown> {
  const child = new AiVaultServiceTestChild()
  spawnMock.mockReturnValue(child.asChildProcess())
  const client = createRelayAiVaultService(
    'C:/Users/Ada',
    getRemoteHostPlatform('win32-x64'),
    baseEnv
  )
  const list = client.listSessions({})
  const init = child.sent[0]
  readyAiVaultServiceChild(child)
  await Promise.resolve()
  const request = child.sent.find(
    (message) => (message as { operation?: string }).operation === 'list'
  ) as { id: number }
  child.emit('message', {
    type: 'result',
    id: request.id,
    operation: 'list',
    value: { sessions: [], issues: [], scannedAt: '2026-08-23T00:00:00.000Z' }
  })
  await list
  const disposing = client.dispose()
  child.emit('exit', 0)
  await disposing
  return init
}

describe('createRelayAiVaultService', () => {
  beforeEach(() => spawnMock.mockReset())

  it('passes the host DEVIN_HOME root to the sidecar init', async () => {
    await expect(
      captureInit({
        APPDATA: 'C:\\Users\\Ada\\AppData\\Roaming',
        DEVIN_HOME: 'D:\\devin-home'
      })
    ).resolves.toMatchObject({
      devinTranscriptsDir: join('D:\\devin-home', 'transcripts')
    })
  })

  it('passes redirected host APPDATA to the sidecar init', async () => {
    await expect(captureInit({ APPDATA: 'D:\\Profiles\\Ada\\Roaming' })).resolves.toMatchObject({
      devinTranscriptsDir: join('D:\\Profiles\\Ada\\Roaming', 'devin', 'cli', 'transcripts')
    })
  })
})
