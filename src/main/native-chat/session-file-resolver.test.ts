import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
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

function indexRollout(home: string, path: string): void {
  const db = new SyncDatabase(join(home, 'state_5.sqlite'))
  try {
    db.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL)')
    db.prepare('INSERT INTO threads VALUES (?, ?)').run('thread-a', path)
  } finally {
    db.close()
  }
}

describe('resolveSessionFilePath', () => {
  it.skipIf(process.platform === 'win32').each(['thread-a', 'other-thread'])(
    'rejects a foreign actual target behind symlink/.. even if the lexical shadow has the requested ID (%s)',
    async (foreignId) => {
      const home = await realpath(await makeRoot('orca-native-codex-actual-target-'))
      const sessions = join(home, 'sessions')
      const foreign = join(home, 'another-account')
      await mkdir(sessions)
      await mkdir(join(foreign, 'child'), { recursive: true })
      await writeFile(
        join(sessions, 'rollout-thread-a.jsonl'),
        '{"type":"session_meta","payload":{"id":"thread-a"}}\n'
      )
      await writeFile(
        join(foreign, 'rollout-thread-a.jsonl'),
        `${JSON.stringify({ type: 'session_meta', payload: { id: foreignId } })}\n`
      )
      await symlink(join(foreign, 'child'), join(sessions, 'link'))
      indexRollout(home, `${sessions}/link/../rollout-thread-a.jsonl`)

      await expect(
        resolveSessionFilePath('codex', 'thread-a', {
          codexSessionsDirs: [sessions],
          strictErrors: true
        })
      ).rejects.toThrow()
    }
  )

  it.skipIf(process.platform === 'win32')(
    'selects the actual in-account target rather than a different lexical shadow',
    async () => {
      const home = await realpath(await makeRoot('orca-native-codex-actual-inside-'))
      const sessions = join(home, 'sessions')
      const target = join(sessions, 'nested', 'rollout-thread-a.jsonl')
      await mkdir(join(sessions, 'nested', 'child'), { recursive: true })
      for (const file of [target, join(sessions, 'rollout-thread-a.jsonl')]) {
        await writeFile(file, '{"type":"session_meta","payload":{"id":"thread-a"}}\n')
      }
      await symlink(join(sessions, 'nested', 'child'), join(sessions, 'link'))
      indexRollout(home, `${sessions}/link/../rollout-thread-a.jsonl`)

      await expect(
        resolveSessionFilePath('codex', 'thread-a', {
          codexSessionsDirs: [sessions],
          strictErrors: true
        })
      ).resolves.toBe(target)
    }
  )

  it.skipIf(process.platform === 'win32')(
    'keeps filename fallback when the actual indexed target is missing behind symlink/..',
    async () => {
      const home = await realpath(await makeRoot('orca-native-codex-actual-missing-'))
      const sessions = join(home, 'sessions')
      const original = join(sessions, 'rollout-thread-a.jsonl')
      const foreign = join(home, 'another-account')
      await mkdir(sessions)
      await mkdir(join(foreign, 'child'), { recursive: true })
      await writeFile(original, '{"type":"session_meta","payload":{"id":"thread-a"}}\n')
      await symlink(join(foreign, 'child'), join(sessions, 'link'))
      indexRollout(home, `${sessions}/link/../rollout-thread-a.jsonl`)

      await expect(
        resolveSessionFilePath('codex', 'thread-a', {
          codexSessionsDirs: [sessions]
        })
      ).resolves.toBe(original)
    }
  )

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
    ).resolves.toBe(await realpath(head))
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
