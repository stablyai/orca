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
  const seedKimiSession = async (
    kimiSessionsDir: string,
    sessionId: string,
    state: Record<string, unknown> | null,
    agents: string[]
  ): Promise<string> => {
    const sessionDir = join(kimiSessionsDir, 'wd_repo_ab12cd34ef56', sessionId)
    await mkdir(sessionDir, { recursive: true })
    if (state) {
      await writeFile(join(sessionDir, 'state.json'), JSON.stringify(state))
    }
    for (const agentId of agents) {
      const agentDir = join(sessionDir, 'agents', agentId)
      await mkdir(agentDir, { recursive: true })
      await writeFile(join(agentDir, 'wire.jsonl'), '{}\n')
    }
    return sessionDir
  }

  it('resolves a Kimi wire.jsonl through the primary agent of state.json', async () => {
    const root = await makeRoot('orca-native-chat-resolve-kimi-')
    const kimiSessionsDir = join(root, 'kimi-sessions')
    const sessionDir = await seedKimiSession(
      kimiSessionsDir,
      'session_0fdbfd01-1234-5678-9abc-def012345678',
      { agents: { main: { type: 'main' }, coder: { type: 'task', parentAgentId: 'main' } } },
      ['main', 'coder']
    )

    await expect(
      resolveSessionFilePath('kimi', 'session_0fdbfd01-1234-5678-9abc-def012345678', {
        kimiSessionsDir
      })
    ).resolves.toBe(join(sessionDir, 'agents', 'main', 'wire.jsonl'))
  })

  it('follows a primary agent whose id is not "main"', async () => {
    const root = await makeRoot('orca-native-chat-resolve-kimi-primary-')
    const kimiSessionsDir = join(root, 'kimi-sessions')
    const sessionDir = await seedKimiSession(
      kimiSessionsDir,
      'session_renamed',
      { agents: { 'agent-7': { type: 'main', parentAgentId: null } } },
      ['agent-7']
    )

    await expect(
      resolveSessionFilePath('kimi', 'session_renamed', { kimiSessionsDir })
    ).resolves.toBe(join(sessionDir, 'agents', 'agent-7', 'wire.jsonl'))
  })

  it('skips non-matching Kimi session dirs without descending into them', async () => {
    const root = await makeRoot('orca-native-chat-resolve-kimi-prune-')
    const kimiSessionsDir = join(root, 'kimi-sessions')
    // An unreadable non-matching session dir would fail the walk if descended.
    await seedKimiSession(kimiSessionsDir, 'session_other', {}, ['main'])
    const sessionDir = await seedKimiSession(kimiSessionsDir, 'session_wanted', {}, ['main'])

    await expect(
      resolveSessionFilePath('kimi', 'session_wanted', { kimiSessionsDir })
    ).resolves.toBe(join(sessionDir, 'agents', 'main', 'wire.jsonl'))
  })

  it('defaults to agents/main when a Kimi state.json lacks the agents map', async () => {
    const root = await makeRoot('orca-native-chat-resolve-kimi-default-')
    const kimiSessionsDir = join(root, 'kimi-sessions')
    const sessionDir = await seedKimiSession(kimiSessionsDir, 'session_abc', {}, ['main'])

    await expect(resolveSessionFilePath('kimi', 'session_abc', { kimiSessionsDir })).resolves.toBe(
      join(sessionDir, 'agents', 'main', 'wire.jsonl')
    )
  })

  it('resolves agents/main/wire.jsonl when a Kimi session has no state.json', async () => {
    const root = await makeRoot('orca-native-chat-resolve-kimi-stateless-')
    const kimiSessionsDir = join(root, 'kimi-sessions')
    // A session killed before its first state.json persist still has its wire.
    const sessionDir = await seedKimiSession(kimiSessionsDir, 'session_stateless', null, ['main'])

    await expect(
      resolveSessionFilePath('kimi', 'session_stateless', { kimiSessionsDir })
    ).resolves.toBe(join(sessionDir, 'agents', 'main', 'wire.jsonl'))
  })

  it('returns null for a state-less Kimi session with no primary wire.jsonl', async () => {
    const root = await makeRoot('orca-native-chat-resolve-kimi-stateless-sub-')
    const kimiSessionsDir = join(root, 'kimi-sessions')
    // Only a subagent wire: no state.json and no agents/main/wire.jsonl.
    await seedKimiSession(kimiSessionsDir, 'session_delegate', null, ['coder'])

    await expect(
      resolveSessionFilePath('kimi', 'session_delegate', { kimiSessionsDir })
    ).resolves.toBeNull()
  })

  it('never resolves a Kimi subagent wire.jsonl for the session id', async () => {
    const root = await makeRoot('orca-native-chat-resolve-kimi-subagent-')
    // A session that only ever delegated: no primary wire.jsonl at all.
    const kimiSessionsDir2 = join(root, 'kimi-sessions-2')
    await seedKimiSession(kimiSessionsDir2, 'session_sub', { agents: {} }, ['coder'])

    await expect(
      resolveSessionFilePath('kimi', 'session_sub', { kimiSessionsDir: kimiSessionsDir2 })
    ).resolves.toBe(
      join(kimiSessionsDir2, 'wd_repo_ab12cd34ef56', 'session_sub', 'agents', 'main', 'wire.jsonl')
    )
    // ...the path points at the primary agent even though that file does not
    // exist yet — the reader reports it as a retry-worthy miss (#8401-style),
    // never as the subagent's conversation.
  })

  it('ignores a stray state.json outside the session directory', async () => {
    const root = await makeRoot('orca-native-chat-resolve-kimi-stray-')
    const kimiSessionsDir = join(root, 'kimi-sessions')
    await mkdir(kimiSessionsDir, { recursive: true })
    // A backup/cache copy at the sessions root must not resolve a bogus path.
    await writeFile(join(kimiSessionsDir, 'state.json'), '{}')
    await seedKimiSession(kimiSessionsDir, 'session_stray', {}, ['main'])

    await expect(resolveSessionFilePath('kimi', 'state', { kimiSessionsDir })).resolves.toBeNull()
    await expect(
      resolveSessionFilePath('kimi', 'session_stray', { kimiSessionsDir })
    ).resolves.toBe(
      join(kimiSessionsDir, 'wd_repo_ab12cd34ef56', 'session_stray', 'agents', 'main', 'wire.jsonl')
    )
  })

  it('returns null for an unknown Kimi session id', async () => {
    const root = await makeRoot('orca-native-chat-resolve-kimi-miss-')
    const kimiSessionsDir = join(root, 'kimi-sessions')
    await seedKimiSession(kimiSessionsDir, 'session_known', {}, ['main'])

    await expect(
      resolveSessionFilePath('kimi', 'session_unknown', { kimiSessionsDir })
    ).resolves.toBeNull()
  })

  it('honors KIMI_CODE_HOME when resolving Kimi transcripts', async () => {
    const root = await makeRoot('orca-native-chat-resolve-kimi-env-')
    const home = join(root, 'kimi-home')
    const sessionDir = await seedKimiSession(join(home, 'sessions'), 'session_env', {}, ['main'])

    const previous = process.env.KIMI_CODE_HOME
    process.env.KIMI_CODE_HOME = home
    try {
      await expect(resolveSessionFilePath('kimi', 'session_env')).resolves.toBe(
        join(sessionDir, 'agents', 'main', 'wire.jsonl')
      )
    } finally {
      restoreEnv('KIMI_CODE_HOME', previous)
    }
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
    // Why: a session's task-subagent transcripts sit in its same-named
    // `<stamp>_<uuid>/` artifact dir, and a label-named child CAN end in
    // `_<session id>`. Asserting the parent wins would only prove the prune on a
    // filesystem that happens to enumerate the dir first, so give the id exactly
    // one match — inside the artifact dir. Pruned resolves to null; descending
    // finds the child, whatever order readdir returns.
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
    // The parent transcript itself still resolves through the pruned walk.
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
