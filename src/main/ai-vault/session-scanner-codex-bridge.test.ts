import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

let tempRoots: string[] = []

afterEach(async () => {
  vi.resetModules()
  vi.restoreAllMocks()
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })))
  tempRoots = []
})

function isolatedNonCodexScanRoots(root: string) {
  return {
    claudeProjectsDir: join(root, 'claude-projects'),
    geminiSessionsDir: join(root, 'gemini-sessions'),
    copilotSessionsDir: join(root, 'copilot-sessions'),
    cursorProjectsDir: join(root, 'cursor-projects'),
    opencodeStorageDir: join(root, 'opencode-storage'),
    opencodeDbPaths: [] as readonly string[],
    grokSessionsDir: join(root, 'grok-sessions'),
    devinTranscriptsDir: join(root, 'devin-transcripts'),
    hermesSessionsDir: join(root, 'hermes-sessions'),
    rovoSessionsDir: join(root, 'rovo-sessions'),
    openclawStateDir: join(root, 'openclaw-state'),
    openclawLegacyStateDir: join(root, 'openclaw-legacy-state'),
    piSessionsDir: join(root, 'pi-sessions'),
    droidSessionsDir: join(root, 'droid-sessions'),
    droidProjectsDir: join(root, 'droid-projects'),
    kimiSessionsDir: join(root, 'kimi-sessions')
  }
}

function jsonLines(records: unknown[]): string {
  return records.map((record) => JSON.stringify(record)).join('\n')
}

describe('Codex runtime home scanning', () => {
  it('uses the Orca runtime home as the default Codex display source', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-ai-vault-codex-runtime-source-'))
    tempRoots.push(root)
    const systemHome = join(root, 'system-codex')
    const runtimeHome = join(root, 'orca', 'codex-runtime-home', 'home')
    const sessionPath = join('2026', '07', '06', 'rollout-runtime-codex-session.jsonl')
    await mkdir(join(systemHome, 'sessions', '2026', '07', '06'), { recursive: true })
    await mkdir(join(runtimeHome, 'sessions', '2026', '07', '06'), { recursive: true })
    await writeFile(
      join(systemHome, 'sessions', sessionPath),
      codexTranscript({
        id: 'system-session',
        cwd: '/Users/ada/system-repo',
        title: 'System Codex session'
      })
    )
    await writeFile(
      join(runtimeHome, 'sessions', sessionPath),
      codexTranscript({
        id: 'runtime-session',
        cwd: '/Users/ada/runtime-repo',
        title: 'Runtime Codex session'
      })
    )

    vi.doMock('../codex/codex-home-paths', () => ({
      getSystemCodexHomePath: () => systemHome,
      getOrcaManagedCodexHomePath: () => runtimeHome
    }))
    const { scanAiVaultSessions } = await import('./session-scanner')

    const result = await scanAiVaultSessions({
      ...isolatedNonCodexScanRoots(root),
      platform: 'darwin'
    })

    expect(result.issues).toEqual([])
    expect(result.sessions).toHaveLength(1)
    expect(result.sessions[0]).toMatchObject({
      agent: 'codex',
      sessionId: 'runtime-session',
      title: 'Runtime Codex session',
      cwd: '/Users/ada/runtime-repo',
      filePath: join(runtimeHome, 'sessions', sessionPath),
      codexHome: runtimeHome,
      resumeCommand: `cd '/Users/ada/runtime-repo' && CODEX_HOME='${runtimeHome}' codex resume 'runtime-session'`
    })
  })
})

function codexTranscript(args: { id: string; cwd: string; title: string }): string {
  return jsonLines([
    {
      timestamp: '2026-07-06T02:49:35.000Z',
      type: 'session_meta',
      payload: {
        id: args.id,
        cwd: args.cwd
      }
    },
    {
      timestamp: '2026-07-06T02:49:36.000Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'text', text: args.title }]
      }
    }
  ])
}
