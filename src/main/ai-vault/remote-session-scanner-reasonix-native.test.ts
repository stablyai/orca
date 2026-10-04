import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { createRelayAiVaultFilesystemProvider } from '../../relay/ai-vault-service-filesystem'
import { getRemoteHostPlatform } from '../ssh/ssh-remote-platform'
import { scanRemoteAiVaultSessions } from './remote-session-scanner'
import { resetRemoteSessionParseCacheForTests } from './remote-session-parse-cache'

const id = '985b66b859ffae5cd8d17ef63ec3d33c'
const hostPlatform = getRemoteHostPlatform('linux-x64')
let root: string
let directory: string
let provider: ReturnType<typeof createRelayAiVaultFilesystemProvider>
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'rx-relay-native-'))
  directory = join(root, '.reasonix/projects/-workspace/sessions-v4', id)
  await mkdir(directory, { recursive: true })
  for (const [source, destination] of [
    ['frames', 'events.frames'],
    ['manifest.json', 'manifest.json']
  ]) {
    await copyFile(
      join(__dirname, '__fixtures__', `reasonix-1-39-7-native-auth-rejection.${source}`),
      join(directory, destination)
    )
  }
  provider = createRelayAiVaultFilesystemProvider({ homeDirectory: root })
})
afterEach(async () => {
  provider.dispose()
  resetRemoteSessionParseCacheForTests()
  await rm(root, { recursive: true, force: true })
})
const scan = (optIn: boolean, scopePaths?: readonly string[]) =>
  scanRemoteAiVaultSessions({
    provider,
    executionHostId: 'ssh:fixture-host',
    remoteHome: root,
    hostPlatform,
    includeReasonixHistory: optIn,
    unlimited: true,
    scopePaths
  })

it('keeps the old host enum unless opted in, then verifies a scoped folder on the execution host', async () => {
  expect((await scan(false)).sessions).toEqual([])
  expect((await scan(true)).sessions).toMatchObject([
    {
      agent: 'reasonix',
      sessionId: id,
      cwd: null,
      resumeCommand: '',
      resumeUnavailableReason: 'workspace-unverified'
    }
  ])
  const result = await scan(true, ['/workspace'])
  expect(result.issues).toEqual([])
  expect(result.sessions).toMatchObject([
    {
      executionHostId: 'ssh:fixture-host',
      agent: 'reasonix',
      sessionId: id,
      cwd: '/workspace'
    }
  ])
  expect(result.sessions[0].resumeCommand).toContain(`reasonix --resume '${id}'`)
})

it('rechecks host metadata at the same transcript stat and refuses a byte-incapable old host', async () => {
  expect((await scan(true, ['/workspace'])).sessions).toHaveLength(1)
  await writeFile(join(directory, 'manifest.json'), '{}')
  const corrupt = await scan(true, ['/workspace'])
  expect(corrupt.sessions).toEqual([])
  expect(corrupt.issues).toContainEqual(
    expect.objectContaining({
      agent: 'reasonix',
      message: expect.stringContaining('Unsupported Reasonix')
    })
  )
  const { readTranscriptBytes: _bytes, ...oldProvider } = provider
  const old = await scanRemoteAiVaultSessions({
    provider: oldProvider,
    executionHostId: 'ssh:fixture-host',
    remoteHome: root,
    hostPlatform,
    includeReasonixHistory: true
  })
  expect(old.sessions).toEqual([])
  expect(old.issues).toContainEqual(
    expect.objectContaining({
      agent: 'reasonix',
      message: expect.stringContaining('transcript-owning host')
    })
  )
})
