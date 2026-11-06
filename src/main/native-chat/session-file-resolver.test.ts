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

  it('resolves a Muse session by its date-sharded directory id, never a subagent log', async () => {
    const root = await makeRoot('orca-native-chat-resolve-muse-')
    const parentId = '01a1afb3-c489-7951-90e1-4e071e67c6b7'
    const childId = 'f83b7f66-004d-4d7e-8e6e-6cd22e579579'
    const sessionDir = join(root, '2026', '11', '05', parentId)
    await mkdir(join(sessionDir, 'subagent', childId), { recursive: true })
    await writeFile(join(sessionDir, 'session.jsonl'), '{}\n')
    await writeFile(join(sessionDir, 'subagent', childId, 'session.jsonl'), '{}\n')

    await expect(resolveSessionFilePath('muse', parentId, { museSessionsDir: root })).resolves.toBe(
      join(sessionDir, 'session.jsonl')
    )
    await expect(
      resolveSessionFilePath('muse', childId, { museSessionsDir: root })
    ).resolves.toBeNull()
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
