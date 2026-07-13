import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { resolveSessionFilePath } from './session-file-resolver'

let tempRoots: string[] = []

afterEach(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })))
  tempRoots = []
})

async function makeRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix))
  tempRoots.push(root)
  return root
}

function restoreEnv(key: string, previous: string | undefined): void {
  if (previous === undefined) {
    delete process.env[key]
  } else {
    process.env[key] = previous
  }
}

describe('resolveSessionFilePath', () => {
  it('globs Claude project subdirs for <sessionId>.jsonl', async () => {
    const root = await makeRoot('orca-native-chat-resolve-claude-')
    const claudeProjectsDir = join(root, 'claude-projects')
    const projectDir = join(claudeProjectsDir, '-Users-ada-repo')
    await mkdir(projectDir, { recursive: true })
    const target = join(projectDir, 'sess-123.jsonl')
    await writeFile(target, '{}\n')

    const resolved = await resolveSessionFilePath('claude', 'sess-123', { claudeProjectsDir })
    expect(resolved).toBe(target)
  })

  it('resolves Grok chat_history.jsonl under encodeURIComponent(cwd)/sessionId', async () => {
    const root = await makeRoot('orca-native-chat-resolve-grok-')
    const grokSessionsDir = join(root, 'grok-sessions')
    const sessionDir = join(grokSessionsDir, encodeURIComponent('/tmp/work'), 'sess-grok-1')
    await mkdir(sessionDir, { recursive: true })
    const target = join(sessionDir, 'chat_history.jsonl')
    await writeFile(target, '{"type":"user","content":"hi"}\n')

    const resolved = await resolveSessionFilePath('grok', 'sess-grok-1', { grokSessionsDir })
    expect(resolved).toBe(target)
  })

  it('resolves Grok chat_history by session id under a long-cwd slug group', async () => {
    const root = await makeRoot('orca-native-chat-resolve-grok-long-')
    const grokSessionsDir = join(root, 'grok-sessions')
    const sessionDir = join(grokSessionsDir, 'slug-hash-ab12', 'sess-long-1')
    await mkdir(sessionDir, { recursive: true })
    const target = join(sessionDir, 'chat_history.jsonl')
    await writeFile(join(grokSessionsDir, 'slug-hash-ab12', '.cwd'), `/${'x'.repeat(400)}\n`)
    await writeFile(target, '{"type":"assistant","content":"ok"}\n')

    await expect(resolveSessionFilePath('grok', 'sess-long-1', { grokSessionsDir })).resolves.toBe(
      target
    )
  })

  it('ignores nested Grok decoys outside the direct group/session layout', async () => {
    const root = await makeRoot('orca-native-chat-resolve-grok-decoy-')
    const grokSessionsDir = join(root, 'grok-sessions')
    const decoy = join(
      grokSessionsDir,
      'group',
      'other-session',
      'nested',
      'sess-decoy',
      'chat_history.jsonl'
    )
    await mkdir(dirname(decoy), { recursive: true })
    await writeFile(decoy, '{}\n')

    await expect(
      resolveSessionFilePath('grok', 'sess-decoy', { grokSessionsDir })
    ).resolves.toBeNull()
  })

  it('rejects unsafe Grok session ids before filesystem discovery', async () => {
    const root = await makeRoot('orca-native-chat-resolve-grok-invalid-')
    const grokSessionsDir = join(root, 'grok-sessions')
    await mkdir(grokSessionsDir, { recursive: true })

    await expect(
      resolveSessionFilePath('grok', '../escape', { grokSessionsDir })
    ).resolves.toBeNull()
  })

  it('resolves Grok sessions under GROK_HOME when no override is passed', async () => {
    const root = await makeRoot('orca-native-chat-resolve-grok-home-')
    const sessionsDir = join(root, 'sessions')
    const sessionDir = join(sessionsDir, encodeURIComponent('/repo'), 'sess-env-1')
    await mkdir(sessionDir, { recursive: true })
    const target = join(sessionDir, 'chat_history.jsonl')
    await writeFile(target, '{}\n')
    const previous = process.env.GROK_HOME
    process.env.GROK_HOME = root
    try {
      await expect(resolveSessionFilePath('grok', 'sess-env-1')).resolves.toBe(target)
    } finally {
      restoreEnv('GROK_HOME', previous)
    }
  })

  it('matches Codex rollout files by session id suffix', async () => {
    const root = await makeRoot('orca-native-chat-resolve-codex-')
    const codexSessionsDir = join(root, 'codex-sessions')
    const dayDir = join(codexSessionsDir, '2026', '06', '04')
    await mkdir(dayDir, { recursive: true })
    const target = join(dayDir, 'rollout-2026-06-04T10-00-00-abc-session.jsonl')
    await writeFile(target, '{}\n')

    const resolved = await resolveSessionFilePath('codex', 'abc-session', {
      codexSessionsDirs: [codexSessionsDir]
    })
    expect(resolved).toBe(target)
  })

  it('resolves a rollout from the orca-managed Codex home (ORCA_USER_DATA_PATH)', async () => {
    // Orca launches Codex with its own managed CODEX_HOME, so rollout files land
    // under <userData>/codex-runtime-home/home/sessions, NOT ~/.codex/sessions.
    const root = await makeRoot('orca-native-chat-resolve-managed-')
    const managedSessionsDir = join(root, 'codex-runtime-home', 'home', 'sessions')
    const dayDir = join(managedSessionsDir, '2026', '06', '19')
    await mkdir(dayDir, { recursive: true })
    const target = join(dayDir, 'rollout-2026-06-19T04-20-39-019edf9c-managed.jsonl')
    await writeFile(target, '{}\n')

    const previous = process.env.ORCA_USER_DATA_PATH
    process.env.ORCA_USER_DATA_PATH = root
    try {
      const resolved = await resolveSessionFilePath('codex', '019edf9c-managed')
      expect(resolved).toBe(target)
    } finally {
      if (previous === undefined) {
        delete process.env.ORCA_USER_DATA_PATH
      } else {
        process.env.ORCA_USER_DATA_PATH = previous
      }
    }
  })

  it('falls back to CODEX_HOME when the managed home has no match', async () => {
    const root = await makeRoot('orca-native-chat-resolve-codex-home-')
    const managedRoot = join(root, 'managed-userdata')
    await mkdir(managedRoot, { recursive: true })
    const codexHome = join(root, 'custom-codex-home')
    const dayDir = join(codexHome, 'sessions', '2026', '06', '05')
    await mkdir(dayDir, { recursive: true })
    const target = join(dayDir, 'rollout-xyz-session.jsonl')
    await writeFile(target, '{}\n')

    const previousCodex = process.env.CODEX_HOME
    const previousUserData = process.env.ORCA_USER_DATA_PATH
    process.env.CODEX_HOME = codexHome
    // Point the managed home at an empty dir so the fallback is exercised.
    process.env.ORCA_USER_DATA_PATH = managedRoot
    try {
      const resolved = await resolveSessionFilePath('codex', 'xyz-session')
      expect(resolved).toBe(target)
    } finally {
      restoreEnv('CODEX_HOME', previousCodex)
      restoreEnv('ORCA_USER_DATA_PATH', previousUserData)
    }
  })

  it('returns null when no transcript matches', async () => {
    const root = await makeRoot('orca-native-chat-resolve-missing-')
    const claudeProjectsDir = join(root, 'claude-projects')
    await mkdir(claudeProjectsDir, { recursive: true })
    expect(await resolveSessionFilePath('claude', 'nope', { claudeProjectsDir })).toBeNull()
  })

  it('returns null for unsupported agents', async () => {
    expect(await resolveSessionFilePath('gemini', 'whatever')).toBeNull()
  })

  it('prefers the hook transcriptPath when it exists (Claude id != file name)', async () => {
    // Recent Claude Code names the file with a UUID that differs from the hook
    // session_id, so the id glob would miss it — but transcript_path is exact.
    const root = await makeRoot('orca-native-chat-resolve-path-')
    const claudeProjectsDir = join(root, 'claude-projects')
    const projectDir = join(claudeProjectsDir, '-Users-ada-repo')
    await mkdir(projectDir, { recursive: true })
    // The real transcript is named by a DIFFERENT id than the hook session id.
    const realFile = join(projectDir, 'real-file-uuid.jsonl')
    await writeFile(realFile, '{}\n')

    const resolved = await resolveSessionFilePath('claude', 'hook-session-id', {
      claudeProjectsDir,
      transcriptPath: realFile
    })
    expect(resolved).toBe(realFile)
  })

  it('falls back to the id glob when the hook transcriptPath does not exist', async () => {
    const root = await makeRoot('orca-native-chat-resolve-path-stale-')
    const claudeProjectsDir = join(root, 'claude-projects')
    const projectDir = join(claudeProjectsDir, '-Users-ada-repo')
    await mkdir(projectDir, { recursive: true })
    const target = join(projectDir, 'sess-xyz.jsonl')
    await writeFile(target, '{}\n')

    const resolved = await resolveSessionFilePath('claude', 'sess-xyz', {
      claudeProjectsDir,
      transcriptPath: join(projectDir, 'does-not-exist.jsonl')
    })
    expect(resolved).toBe(target)
  })

  it('ignores a non-jsonl transcriptPath and falls back to the glob', async () => {
    const root = await makeRoot('orca-native-chat-resolve-path-ext-')
    const claudeProjectsDir = join(root, 'claude-projects')
    const projectDir = join(claudeProjectsDir, '-Users-ada-repo')
    await mkdir(projectDir, { recursive: true })
    const bogus = join(projectDir, 'not-a-transcript.txt')
    await writeFile(bogus, 'x')
    const target = join(projectDir, 'sess-ok.jsonl')
    await writeFile(target, '{}\n')

    const resolved = await resolveSessionFilePath('claude', 'sess-ok', {
      claudeProjectsDir,
      transcriptPath: bogus
    })
    expect(resolved).toBe(target)
  })
})
