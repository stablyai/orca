import { readFile, mkdtemp, rm, stat } from 'node:fs/promises'
import { getRemoteHostPlatform } from '../ssh/ssh-remote-platform'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { AI_VAULT_AGENT_SOURCES } from './session-scanner-agent-sources'
import { isolatedScanRoots, writeJsonlFile } from './session-scanner-test-fixtures'
import { scanAiVaultSessions } from './session-scanner'
import {
  createQoderSessionResumeState,
  parseQoderSessionContent
} from './session-scanner-qoder-parser'
import { remoteSessionSources } from './remote-session-scanner-sources'
import { resetSessionParseCacheForTests } from './session-scanner-parse-cache'
import type { TranscriptMessage } from './session-transcript-consumers'

const roots: string[] = []
afterEach(async () => {
  resetSessionParseCacheForTests()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true })))
})

it('decodes a real generated and resumed Qoder 1.1.64 session for preview and search', async () => {
  const path = join(__dirname, '__fixtures__', 'qoder-1.1.64-generated-resumed.jsonl')
  const content = await readFile(path, 'utf8')
  const file = { path, mtimeMs: 1, modifiedAt: '2026-10-02T07:14:07.626Z' }
  const messages: TranscriptMessage[] = []
  const state = createQoderSessionResumeState(file, {
    active: true,
    push: (message) => messages.push(message)
  })
  const lines = content.trim().split('\n')
  const split = lines.findIndex((line) => line.includes('What exact marker'))
  for (const line of lines.slice(0, split)) {
    state.consumeLine(line)
  }
  const before = await state.finalize('darwin')
  const resumed = state.clone()
  for (const line of lines.slice(split)) {
    resumed.consumeLine(line)
  }
  const after = await resumed.finalize('darwin')
  expect(after).toMatchObject({
    agent: 'qoder',
    cwd: '/tmp/qoder-proof',
    model: 'qmodel_38max',
    sessionId: 'faa75b79-790e-4c44-8f3e-c7145d18eb7e'
  })
  expect(after?.resumeCommand).toContain("qodercli --resume 'faa75b79-790e-4c44-8f3e-c7145d18eb7e'")
  expect(after?.previewMessages.at(-1)?.text).toBe('QODER_ORCA_PROOF_1002')
  expect(before?.previewMessages.at(-1)?.text).toBe('QODER_ORCA_COMPLETE_1002')
  expect(messages.some((m) => m.role === 'assistant' && m.text === 'QODER_ORCA_PROOF_1002')).toBe(
    true
  )
  expect(messages.some((m) => m.text.includes("I'm creating the file now"))).toBe(false)
  expect(messages.every((message) => message.role !== 'tool')).toBe(true)
  expect(messages.some((message) => message.text.includes('File created successfully'))).toBe(false)
  expect(
    after?.previewMessages.some((message) => message.text.includes('File created successfully'))
  ).toBe(false)
  const remote = await parseQoderSessionContent(file, content, 'linux', {
    executionHostId: 'ssh:test'
  })
  expect(remote).toMatchObject({
    agent: 'qoder',
    executionHostId: 'ssh:test',
    cwd: '/tmp/qoder-proof'
  })
})

it('discovers Qoder folder history and prunes nested workers on local, WSL, and SSH hosts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orca-qoder-vault-'))
  roots.push(root)
  const options = isolatedScanRoots(root)
  const path = join(options.qoderProjectsDir, 'folder', 'qoder-session.jsonl')
  const records = [
    { type: 'workspace-directories', sessionId: 'qoder-session', directories: ['/tmp/folder'] },
    {
      type: 'user',
      sessionId: 'qoder-session',
      message: { role: 'user', content: 'Qoder folder proof' }
    }
  ]
  await writeJsonlFile(path, records)
  await writeJsonlFile(
    join(options.qoderProjectsDir, 'folder', 'qoder-session', 'subagents', 'worker.jsonl'),
    records
  )
  const result = await scanAiVaultSessions({ ...options, wslHomeDirs: [] })
  const sessions = result.sessions.filter((s) => s.agent === 'qoder')
  expect(sessions).toHaveLength(1)
  expect(sessions[0]).toMatchObject({ title: 'Qoder folder proof', cwd: '/tmp/folder' })
  expect(AI_VAULT_AGENT_SOURCES.qoder?.rootDirs(options, ['/home/test'])).toContain(
    join('/home/test', '.qoder', 'projects')
  )
  for (const platform of ['darwin-arm64', 'linux-x64', 'win32-x64'] as const) {
    const source = remoteSessionSources(
      platform === 'win32-x64' ? 'C:\\Users\\test' : '/home/test',
      getRemoteHostPlatform(platform)
    ).find((s) => s.agent === 'qoder')
    expect(source).toBeDefined()
    expect(source?.partitionSubagentTranscripts).toBeDefined()
  }
  expect((await stat(path)).size).toBeGreaterThan(0)
})
