import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { getRemoteHostPlatform } from '../ssh/ssh-remote-platform'
import { MemoryRemoteProvider } from './remote-session-scanner-test-fixtures'
import { scanRemoteAiVaultSessions } from './remote-session-scanner'
import { isolatedScanRoots } from './session-scanner-test-fixtures'
import { parseDevinSessionContent } from './session-scanner-devin-parser'
import { dedupeScannedSessions, ScannedSessionCollection } from './session-root-dedup'

const roots: string[] = []
afterEach(async () => {
  vi.unstubAllEnvs()
  vi.resetModules()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function transcript(sessionId: string, timestamp = '2026-09-19T00:00:00Z'): string {
  return JSON.stringify({
    schema_version: 'ATIF-v1.7',
    session_id: sessionId,
    steps: [{ source: 'user', message: sessionId, timestamp }]
  })
}

it('lists a session in both default directories once and still fills the scan limit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'devin-dedup-'))
  roots.push(root)
  vi.stubEnv('DEVIN_HOME', root)
  vi.resetModules()
  for (const dir of ['transcripts', 'agent_logs']) {
    await mkdir(join(root, dir))
    await writeFile(join(root, dir, `${dir}-same.json`), transcript('same'))
  }
  await writeFile(
    join(root, 'transcripts', 'other.json'),
    transcript('other', '2026-09-18T00:00:00Z')
  )
  const { scanAiVaultSessions } = await import('./session-scanner')
  const { devinTranscriptsDir: _unused, ...options } = isolatedScanRoots(root)
  const result = await scanAiVaultSessions({ ...options, limit: 2 })
  expect(result.sessions.map((session) => session.sessionId)).toEqual(['same', 'other'])
  const unlimited = await scanAiVaultSessions({ ...options, unlimited: true })
  expect(unlimited.sessions.map((session) => session.sessionId)).toEqual(['same', 'other'])
})

it.each(['win32-x64', 'linux-x64'] as const)(
  'deduplicates both remote directories on %s',
  async (platform) => {
    const provider = new MemoryRemoteProvider()
    const windows = platform === 'win32-x64'
    const home = windows ? 'C:/Users/ada' : '/home/ada'
    const cliDir = `${home}/${windows ? 'AppData/Roaming' : '.local/share'}/devin/cli`
    provider.addFile(`${cliDir}/transcripts/same.json`, transcript('same'), 10)
    provider.addFile(`${cliDir}/agent_logs/devin-same.json`, transcript('same'), 20)
    provider.addFile(
      `${cliDir}/transcripts/other.json`,
      transcript('other', '2026-09-18T00:00:00Z'),
      5
    )
    const result = await scanRemoteAiVaultSessions({
      provider,
      remoteHome: home,
      executionHostId: 'ssh:devin',
      hostPlatform: getRemoteHostPlatform(platform),
      limit: 2
    })
    expect(result.sessions.map((session) => session.sessionId)).toEqual(['same', 'other'])
    expect(result.sessions[0].filePath).toBe(`${cliDir}/agent_logs/devin-same.json`)
  }
)

function session(path: string) {
  const parsed = parseDevinSessionContent(
    { path, mtimeMs: 100, sizeBytes: 1, modifiedAt: new Date(100).toISOString() },
    transcript('same'),
    'win32'
  )
  if (!parsed) {
    throw new Error('Devin fixture did not parse')
  }
  return parsed
}

it('keeps the newest export, prefers agent_logs on ties, and isolates execution hosts and installs', () => {
  const older = session('C:/Users/ada/devin/transcripts/same.json')
  const current = session('C:/Users/ada/devin/agent_logs/devin-same.json')
  const newer = { ...older, modifiedAt: '2026-09-20T00:00:00Z' }
  const remote = { ...current, executionHostId: 'ssh:other' as const }
  const wsl = session('\\\\wsl$\\Ubuntu\\home\\ada\\devin\\agent_logs\\devin-same.json')
  const otherInstall = session('C:/Users/other/devin/agent_logs/devin-same.json')
  for (const rows of [
    [older, current],
    [current, older]
  ]) {
    expect(dedupeScannedSessions(rows)).toEqual([current])
  }
  const rows = [older, current, remote, wsl, otherInstall, newer]
  const expected = [remote, wsl, otherInstall, newer]
  expect(dedupeScannedSessions(rows)).toEqual(expected)
  const collection = new ScannedSessionCollection()
  for (const row of rows) {
    collection.add(row)
  }
  expect([...collection.values()]).toEqual(expected)
  expect(collection.size).toBe(4)
})
