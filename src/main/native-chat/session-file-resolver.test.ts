import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { resolveSessionFilePath } from './session-file-resolver'
import SyncDatabase from '../sqlite/sync-database'

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
  it('imports the indexed Codex continuation instead of an older same-ID rollout', async () => {
    const home = await makeRoot('orca-native-chat-codex-head-')
    const sessions = join(home, 'sessions')
    const original = join(sessions, '2026', '10', '01', 'rollout-thread-a.jsonl')
    const head = join(sessions, '2026', '11', '04', 'rollout-thread-a_segment-b.jsonl')
    await mkdir(dirname(original), { recursive: true })
    await mkdir(dirname(head), { recursive: true })
    const meta = JSON.stringify({
      type: 'session_meta',
      payload: { id: 'thread-a', base_instructions: { text: 'x'.repeat(70_000) } }
    })
    await writeFile(original, `${meta}\n{"type":"event_msg","payload":{"message":"older"}}\n`)
    await writeFile(head, `${meta}\n{"type":"event_msg","payload":{"message":"latest"}}\n`)
    const db = new SyncDatabase(join(home, 'state_5.sqlite'))
    try {
      db.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL)')
      db.prepare('INSERT INTO threads VALUES (?, ?)').run('thread-a', head)
    } finally {
      db.close()
    }

    await expect(
      resolveSessionFilePath('codex', 'thread-a', { codexSessionsDirs: [sessions] })
    ).resolves.toBe(head)
  })

  it('refuses an indexed Codex rollout outside the requested account', async () => {
    const home = await makeRoot('orca-native-chat-codex-foreign-')
    const sessions = join(home, 'sessions')
    const original = join(sessions, '2026', '10', '01', 'rollout-thread-a.jsonl')
    const foreign = join(home, 'another-account', 'rollout-thread-a.jsonl')
    await mkdir(dirname(original), { recursive: true })
    await mkdir(dirname(foreign), { recursive: true })
    const meta = JSON.stringify({ type: 'session_meta', payload: { id: 'thread-a' } })
    await writeFile(original, `${meta}\n`)
    await writeFile(foreign, `${meta}\n`)
    const db = new SyncDatabase(join(home, 'state_5.sqlite'))
    try {
      db.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL)')
      db.prepare('INSERT INTO threads VALUES (?, ?)').run('thread-a', foreign)
    } finally {
      db.close()
    }

    await expect(
      resolveSessionFilePath('codex', 'thread-a', {
        codexSessionsDirs: [sessions],
        strictErrors: true
      })
    ).rejects.toThrow('The indexed Codex rollout does not match this account and session.')
  })

  it('refuses an indexed Codex rollout whose metadata names another session', async () => {
    const home = await makeRoot('orca-native-chat-codex-wrong-id-')
    const sessions = join(home, 'sessions')
    const original = join(sessions, '2026', '10', '01', 'rollout-thread-a.jsonl')
    const head = join(sessions, '2026', '11', '04', 'rollout-thread-a_segment-b.jsonl')
    await mkdir(dirname(original), { recursive: true })
    await mkdir(dirname(head), { recursive: true })
    await writeFile(original, '{"type":"session_meta","payload":{"id":"thread-a"}}\n')
    await writeFile(head, '{"type":"session_meta","payload":{"id":"other-thread"}}\n')
    const db = new SyncDatabase(join(home, 'state_5.sqlite'))
    try {
      db.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL)')
      db.prepare('INSERT INTO threads VALUES (?, ?)').run('thread-a', head)
    } finally {
      db.close()
    }

    await expect(
      resolveSessionFilePath('codex', 'thread-a', {
        codexSessionsDirs: [sessions],
        strictErrors: true
      })
    ).rejects.toThrow('The indexed Codex rollout does not match this account and session.')
  })

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

  it('resolves OpenClaude sessions from the Claude transcript layout', async () => {
    const root = await makeRoot('orca-native-chat-resolve-openclaude-')
    const claudeProjectsDir = join(root, 'claude-projects')
    const projectDir = join(claudeProjectsDir, '-Users-ada-repo')
    await mkdir(projectDir, { recursive: true })
    const target = join(projectDir, 'sess-openclaude.jsonl')
    await writeFile(target, '{}\n')

    await expect(
      resolveSessionFilePath('openclaude', 'sess-openclaude', { claudeProjectsDir })
    ).resolves.toBe(target)
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

  it('matches omp transcripts by session id suffix inside the per-cwd directory', async () => {
    const root = await makeRoot('orca-native-chat-resolve-omp-')
    const ompSessionsDir = join(root, 'omp-sessions')
    const cwdDir = join(ompSessionsDir, '-Users-ada-repo')
    await mkdir(cwdDir, { recursive: true })
    const target = join(cwdDir, '2026-07-16T00-27-02-222Z_sess-omp-1.jsonl')
    await writeFile(target, '{}\n')

    const resolved = await resolveSessionFilePath('omp', 'sess-omp-1', { ompSessionsDir })
    expect(resolved).toBe(target)
  })

  it('never descends into an omp session artifact dir', async () => {
    // Put the only match inside the artifact directory so success cannot depend on readdir ordering.
    const root = await makeRoot('orca-native-chat-resolve-omp-artifact-')
    const ompSessionsDir = join(root, 'omp-sessions')
    const cwdDir = join(ompSessionsDir, '-Users-ada-repo')
    const stem = '2026-07-16T00-27-02-222Z_019fd8e2-fd56-7000-acfe-2e497adfa83c'
    await mkdir(join(cwdDir, stem), { recursive: true })
    await writeFile(join(cwdDir, `${stem}.jsonl`), '{}\n')
    await writeFile(join(cwdDir, stem, 'worker_sess-omp-child.jsonl'), '{}\n')

    await expect(
      resolveSessionFilePath('omp', 'sess-omp-child', { ompSessionsDir })
    ).resolves.toBeNull()
    await expect(
      resolveSessionFilePath('omp', '019fd8e2-fd56-7000-acfe-2e497adfa83c', { ompSessionsDir })
    ).resolves.toBe(join(cwdDir, `${stem}.jsonl`))
  })

  it('honors OMP_CODING_AGENT_DIR when resolving omp transcripts', async () => {
    const root = await makeRoot('orca-native-chat-resolve-omp-env-')
    const cwdDir = join(root, 'omp-sessions', '-Users-ada-repo')
    await mkdir(cwdDir, { recursive: true })
    const target = join(cwdDir, '2026-07-16T00-27-02-222Z_sess-omp-env.jsonl')
    await writeFile(target, '{}\n')

    const previous = process.env.OMP_CODING_AGENT_DIR
    process.env.OMP_CODING_AGENT_DIR = join(root, 'omp-sessions')
    try {
      await expect(resolveSessionFilePath('omp', 'sess-omp-env')).resolves.toBe(target)
    } finally {
      restoreEnv('OMP_CODING_AGENT_DIR', previous)
    }
  })

  it('resolves a rollout from the orca-managed Codex home (ORCA_USER_DATA_PATH)', async () => {
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
    const root = await makeRoot('orca-native-chat-resolve-path-')
    const claudeProjectsDir = join(root, 'claude-projects')
    const projectDir = join(claudeProjectsDir, '-Users-ada-repo')
    await mkdir(projectDir, { recursive: true })
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

// Mobile uses default roots, which must match the CLI’s CLAUDE_CONFIG_DIR or its transcript disappears.
describe('the default Claude transcript root mobile falls back to', () => {
  it('follows CLAUDE_CONFIG_DIR, the same variable the pinned account home follows', async () => {
    const configDir = await makeRoot('orca-native-chat-claude-config-dir-')
    const slugDir = join(configDir, 'projects', '-repos-workspace-1')
    await mkdir(slugDir, { recursive: true })
    const transcript = join(slugDir, 'session-under-config-dir.jsonl')
    await writeFile(transcript, '', 'utf8')
    const previous = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = configDir

    try {
      await expect(resolveSessionFilePath('claude', 'session-under-config-dir')).resolves.toBe(
        transcript
      )
    } finally {
      restoreEnv('CLAUDE_CONFIG_DIR', previous)
    }
  })

  it('ignores a blank CLAUDE_CONFIG_DIR rather than resolving against the filesystem root', async () => {
    const previous = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = '   '

    try {
      await expect(
        resolveSessionFilePath('claude', 'session-that-does-not-exist')
      ).resolves.toBeNull()
    } finally {
      restoreEnv('CLAUDE_CONFIG_DIR', previous)
    }
  })
})
