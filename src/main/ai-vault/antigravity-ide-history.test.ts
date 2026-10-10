import { runProcess } from '@orca/process-host'
import { mkdtemp, mkdir, rm, writeFile, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { scanAiVaultSessions } from './session-scanner'
import { isolatedScanRoots, writeAntigravityTranscript } from './session-scanner-test-fixtures'
import { MemoryRemoteProvider, jsonLines } from './remote-session-scanner-test-fixtures'
import { scanRemoteAiVaultSessions } from './remote-session-scanner'
import { getRemoteHostPlatform } from '../ssh/ssh-remote-platform'
import { dedupeScannedSessions } from './session-root-dedup'
import { antigravitySessionOrigin } from '../../shared/antigravity-session-origin'
import { readLocalAntigravityHistory } from './session-scanner-antigravity-history'
import { ANTIGRAVITY_INDEX_MAX_BYTES } from './session-scanner-antigravity-metadata'

const temporaryDirectories: string[] = []
const conversationId = 'same-conversation-id'
const origins = ['antigravity-cli', 'antigravity-ide', 'antigravity'] as const
function records(prompt = 'Continue this verified example') {
  return [
    {
      source: 'USER_EXPLICIT',
      type: 'USER_INPUT',
      created_at: '2026-10-02T01:00:00Z',
      content: `<USER_REQUEST>${prompt}</USER_REQUEST>`
    }
  ]
}
async function temporaryHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'orca-agy-ide-'))
  temporaryDirectories.push(home)
  return home
}
afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((home) => rm(home, { recursive: true, force: true }))
  )
})

describe('Antigravity IDE history discovery', () => {
  it('requires client opt-in and keeps equal IDs in separate origins while selecting the full transcript', async () => {
    const home = await temporaryHome()
    for (const origin of origins) {
      const path = await writeAntigravityTranscript(
        join(home, '.gemini', origin, 'brain'),
        conversationId,
        records(origin)
      )
      await writeFile(
        join(dirname(path), 'transcript_full.jsonl'),
        `${jsonLines(records(origin))}\n`
      )
      await writeFile(
        join(dirname(path), 'artifact.jsonl'),
        `${jsonLines(records('Not history'))}\n`
      )
    }
    const options = {
      ...isolatedScanRoots(home),
      antigravityBrainDir: join(home, '.gemini', 'antigravity-cli', 'brain'),
      antigravityAppHome: home
    }
    const legacy = await scanAiVaultSessions(options)
    expect(legacy.sessions).toHaveLength(1)
    expect(antigravitySessionOrigin(legacy.sessions[0]!.filePath)).toBe('antigravity-cli')
    const result = await scanAiVaultSessions({ ...options, includeAntigravityIdeSessions: true })
    expect(result.issues).toEqual([])
    expect(result.sessions).toHaveLength(3)
    expect(new Set(result.sessions.map((session) => session.id)).size).toBe(3)
    for (const session of result.sessions) {
      expect(session.filePath).toContain('transcript_full.jsonl')
      if (antigravitySessionOrigin(session.filePath) === 'antigravity-cli') {
        expect(session.resumeCommand).toContain('--conversation')
      } else {
        expect(session.resumeCommand).toContain('--prompt-interactive')
        expect(session.resumeCommand).not.toContain('--conversation')
        expect(session.resumeCommand).toContain(session.filePath)
      }
    }
  })

  it('joins bounded metadata by exact conversation ID within each origin and refuses conflicting workspaces', async () => {
    const home = await temporaryHome()
    for (const origin of origins) {
      const brain = join(home, '.gemini', origin, 'brain')
      await writeAntigravityTranscript(brain, conversationId, records('Same title across origins'))
      const cache = join(dirname(brain), 'cache')
      await mkdir(cache, { recursive: true })
      await writeFile(
        join(cache, 'conversation_metadata.json'),
        JSON.stringify({
          conversations: { [conversationId]: { summary: { ProjectID: 'project-id' } } }
        })
      )
      await writeFile(
        join(cache, 'projects.json'),
        JSON.stringify({ 'project-id': `/projects/${origin}` })
      )
      if (origin === 'antigravity') {
        await writeFile(
          join(cache, 'last_conversations.json'),
          JSON.stringify({ '/conflicting-workspace': conversationId })
        )
      }
    }
    const result = await scanAiVaultSessions({
      ...isolatedScanRoots(home),
      antigravityBrainDir: join(home, '.gemini', 'antigravity-cli', 'brain'),
      antigravityAppHome: home,
      includeAntigravityIdeSessions: true
    })
    expect(result.sessions).toHaveLength(3)
    for (const session of result.sessions) {
      const origin = antigravitySessionOrigin(session.filePath)
      expect(session.cwd).toBe(origin === 'antigravity' ? null : `/projects/${origin}`)
    }
  })

  it('discovers IDE and 2.0 history in the selected WSL home without falling into sibling artifacts', async () => {
    const home = await temporaryHome()
    const wslHome = join(home, 'wsl-home')
    for (const origin of origins) {
      await writeAntigravityTranscript(
        join(wslHome, '.gemini', origin, 'brain'),
        conversationId,
        records(origin)
      )
    }
    const result = await scanAiVaultSessions({
      ...isolatedScanRoots(home),
      wslHomeDirs: [wslHome],
      includeAntigravityIdeSessions: true,
      platform: 'linux'
    })
    expect(result.sessions).toHaveLength(3)
    expect(result.sessions.every((session) => session.filePath.startsWith(wslHome))).toBe(true)
  })

  it('selects an older full sibling even when the raw discovery cap only retained its compact file', async () => {
    const home = await temporaryHome()
    const brain = join(home, '.gemini', 'antigravity-ide', 'brain')
    const compact = await writeAntigravityTranscript(brain, conversationId, records())
    const full = join(dirname(compact), 'transcript_full.jsonl')
    await writeFile(full, `${jsonLines(records())}\n`)
    await utimes(full, new Date('2026-10-01T00:00:00Z'), new Date('2026-10-01T00:00:00Z'))
    const result = await scanAiVaultSessions({
      ...isolatedScanRoots(home),
      antigravityAppHome: home,
      includeAntigravityIdeSessions: true,
      limit: 1,
      limitPerAgent: 1
    })
    expect(result.sessions).toHaveLength(1)
    expect(result.sessions[0]?.filePath).toBe(full)
  })

  it.skipIf(process.platform === 'win32')(
    'lists all origins despite a FIFO metadata cache and retains transcript workspace fallback',
    async () => {
      const home = await temporaryHome()
      for (const origin of origins) {
        const brain = join(home, '.gemini', origin, 'brain')
        await writeAntigravityTranscript(brain, conversationId, records(origin))
        const cache = join(dirname(brain), 'cache')
        await mkdir(cache, { recursive: true })
        const result = await runProcess({
          program: 'mkfifo',
          args: [join(cache, 'projects.json')],
          timeoutMs: 2000
        })
        expect(result.code).toBe(0)
      }
      const result = await scanAiVaultSessions({
        ...isolatedScanRoots(home),
        antigravityBrainDir: join(home, '.gemini', 'antigravity-cli', 'brain'),
        antigravityAppHome: home,
        includeAntigravityIdeSessions: true
      })
      expect(result.sessions).toHaveLength(3)
      expect(result.issues).toEqual([])
      expect(result.sessions.every((session) => session.cwd === null)).toBe(true)
    },
    5000
  )

  it('does not retain an oversized metadata file', async () => {
    const home = await temporaryHome()
    const file = join(home, 'oversized.json')
    await writeFile(file, ' '.repeat(ANTIGRAVITY_INDEX_MAX_BYTES + 1))
    expect(await readLocalAntigravityHistory(file)).toBeNull()
  })

  it('reads only the execution host and never collapses equal origin IDs from different remote hosts', async () => {
    const provider = new MemoryRemoteProvider()
    const remoteHome = '/remote/home'
    for (const origin of origins) {
      const logs = `${remoteHome}/.gemini/${origin}/brain/${conversationId}/.system_generated/logs`
      provider.addFile(`${logs}/transcript_full.jsonl`, jsonLines(records(origin)), 10)
      provider.addFile(`${logs}/transcript.jsonl`, jsonLines(records(origin)), 11)
    }
    const read = vi.spyOn(provider, 'readFile')
    const options = {
      provider,
      remoteHome,
      hostPlatform: getRemoteHostPlatform('linux-x64'),
      includeAntigravityIdeSessions: true
    }
    const first = await scanRemoteAiVaultSessions({ ...options, executionHostId: 'ssh:first-host' })
    const second = await scanRemoteAiVaultSessions({
      ...options,
      executionHostId: 'ssh:second-host'
    })
    expect(first.sessions).toHaveLength(3)
    expect(second.sessions).toHaveLength(3)
    expect(dedupeScannedSessions([...first.sessions, ...second.sessions])).toHaveLength(6)
    expect(read.mock.calls.every(([path]) => path.startsWith(remoteHome))).toBe(true)
    expect(provider.readDirPaths.every((path) => path.startsWith(remoteHome))).toBe(true)
    expect(
      first.sessions.every((session) => session.filePath.endsWith('transcript_full.jsonl'))
    ).toBe(true)
    const legacy = await scanRemoteAiVaultSessions({
      ...options,
      executionHostId: 'ssh:first-host',
      includeAntigravityIdeSessions: false
    })
    expect(legacy.sessions).toHaveLength(1)
  })
})
