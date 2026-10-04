import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { scanAiVaultSessions } from './session-scanner'
import {
  parseAgentSessionFileCached,
  resetSessionParseCacheForTests
} from './session-scanner-parse-cache'
import { isolatedScanRoots } from './session-scanner-test-fixtures'
import { sessionCandidate } from '../ai-vault-search/session-search-transcript-fixtures'
import { readReasonixDecodedHistorySnapshot } from './reasonix-decoded-history-snapshot'
import { reasonixCollisionProjectName } from './session-scanner-reasonix-workspace'
import { buildAiVaultResumeCommand } from '../../shared/ai-vault-resume-command'

const id = '985b66b859ffae5cd8d17ef63ec3d33c'
let root = ''
let path = ''
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'rx-integration-'))
  path = join(root, 'reasonix/projects/-workspace/sessions-v4', id, 'events.frames')
  await mkdir(dirname(path), { recursive: true })
  for (const [source, destination] of [
    ['frames', 'events.frames'],
    ['manifest.json', 'manifest.json']
  ]) {
    await copyFile(
      join(__dirname, '__fixtures__', `reasonix-1-39-7-native-auth-rejection.${source}`),
      join(dirname(path), destination)
    )
  }
})
afterEach(async () => {
  resetSessionParseCacheForTests()
  await rm(root, { recursive: true, force: true })
})

it('discovers fresh native RX4F only for an opted-in client and verifies a supplied folder root', async () => {
  const roots = isolatedScanRoots(root)
  expect(
    (await scanAiVaultSessions({ ...roots, unlimited: true })).sessions.filter(
      (session) => session.agent === 'reasonix'
    )
  ).toEqual([])
  const result = await scanAiVaultSessions({
    ...roots,
    unlimited: true,
    includeReasonixHistory: true,
    reasonixWorkspaceRoots: ['/workspace']
  })
  expect(result.issues).toEqual([])
  const session = result.sessions.find((session) => session.agent === 'reasonix')
  expect(session).toMatchObject({
    agent: 'reasonix',
    sessionId: id,
    cwd: '/workspace',
    lastUserPrompt: 'Record this harmless observer prompt. Do not run tools.'
  })
  expect(session?.resumeCommand).toContain(`reasonix --resume '${id}'`)
  expect(session?.resumeCommand).toContain('REASONIX_STATE_HOME=')
  expect(session?.previewMessages.some((message) => message.role === 'assistant')).toBe(false)
})

it('keeps history visible but refuses resume without trustworthy workspace metadata', async () => {
  const candidate = await sessionCandidate('reasonix', path)
  const session = await parseAgentSessionFileCached(candidate, process.platform)
  expect(session).toMatchObject({
    sessionId: id,
    cwd: null,
    resumeCommand: '',
    resumeUnavailableReason: 'workspace-unverified'
  })
  expect(
    buildAiVaultResumeCommand({
      agent: 'reasonix',
      sessionId: id,
      cwd: null,
      resumeFilePath: path,
      platform: process.platform
    })
  ).toBe('')
  const decoded = await readReasonixDecodedHistorySnapshot(path)
  expect(decoded).toMatchObject({ isBinary: false, decodedReasonixHistory: true })
  expect(decoded.content).toContain('Record this harmless observer prompt')
  expect(decoded.content).not.toContain('"role":"assistant"')
})

it('rechecks metadata even when the cached transcript stat has not moved', async () => {
  const candidate = await sessionCandidate('reasonix', path)
  expect(await parseAgentSessionFileCached(candidate, process.platform)).not.toBeNull()
  const before = await stat(path)
  await writeFile(join(dirname(path), 'manifest.json'), '{}')
  await expect(parseAgentSessionFileCached(candidate, process.platform)).rejects.toThrow(
    'Unsupported Reasonix history format'
  )
  expect((await stat(path)).mtimeMs).toBe(before.mtimeMs)
})

it('uses source-native desktop roots or collision markers and refuses conflicts', async () => {
  await writeFile(
    join(root, 'reasonix/desktop-projects.json'),
    JSON.stringify({ projects: [{ root: '/workspace' }] })
  )
  const candidate = await sessionCandidate('reasonix', path)
  expect(await parseAgentSessionFileCached(candidate, process.platform)).toMatchObject({
    cwd: '/workspace'
  })
  const project = join(root, 'reasonix/projects', reasonixCollisionProjectName('/workspace'))
  await mkdir(join(project, 'sessions-v4', id), { recursive: true })
  await writeFile(join(project, '.workspace-root'), '/workspace\n')
  for (const file of ['events.frames', 'manifest.json']) {
    await copyFile(join(dirname(path), file), join(project, 'sessions-v4', id, file))
  }
  const collision = await sessionCandidate(
    'reasonix',
    join(project, 'sessions-v4', id, 'events.frames')
  )
  expect(await parseAgentSessionFileCached(collision, process.platform)).toMatchObject({
    cwd: '/workspace'
  })
  await writeFile(join(project, '.workspace-root'), '/another\n')
  await expect(parseAgentSessionFileCached(collision, process.platform)).rejects.toThrow(
    'ownership'
  )
})

it('refuses corrupt frames and closes an already aborted decoded read', async () => {
  const bytes = await readFile(path)
  bytes.write('BAD!', 0)
  await writeFile(path, bytes)
  await expect(readReasonixDecodedHistorySnapshot(path)).rejects.toThrow('magic')
  const controller = new AbortController()
  controller.abort()
  await expect(readReasonixDecodedHistorySnapshot(path, controller.signal)).rejects.toThrow()
})
