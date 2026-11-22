import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { agentJournalItemKey } from '../../../../shared/agent-session/journal/agent-session-journal-item-key'
import { prepareLegacyTranscriptImport } from './journal-legacy-import'
import { resolveAdoptedTranscriptFolder } from './adopted-transcript-source'
import { encodeClaudeProjectPath } from '../../../ai-vault/scanners/claude/claude-project-dir-encoding'
import { grokEncodedCwdDirName } from '../../../../shared/agent-hook-listener/providers/grok/grok-session-paths'

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-journal-import-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function writeFixture(name: string, lines: unknown[]): Promise<string> {
  const path = join(root, name)
  await writeFile(path, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`, 'utf-8')
  return path
}

it.each([true, false])(
  'derives terminal proof for an imported OMP latest root from stopReason, completed: %s',
  async (completed) => {
    const filePath = await writeFixture('fork-tip.jsonl', [
      { type: 'session', id: 'omp-source', cwd: root },
      { type: 'message', id: 'u1', message: { role: 'user', content: 'First prompt' } },
      {
        type: 'message',
        id: 'a1',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'First response' }],
          stopReason: 'stop'
        }
      },
      { type: 'message', id: 'u2', message: { role: 'user', content: 'Latest prompt' } },
      {
        type: 'message',
        id: 'a2',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Latest prose' }],
          ...(completed ? { stopReason: 'stop' } : {})
        }
      }
    ])
    const imported = await prepareLegacyTranscriptImport({
      agent: 'omp',
      sessionId: 'omp-source',
      options: { filePath }
    })
    expect(imported).toMatchObject({
      ok: true,
      forkTipItemIds: completed
        ? [
            agentJournalItemKey({
              provider: 'legacy',
              agent: 'omp',
              sessionId: 'omp-source',
              recordId: 'u2'
            }),
            agentJournalItemKey({
              provider: 'legacy',
              agent: 'omp',
              sessionId: 'omp-source',
              recordId: 'a2'
            })
          ]
        : []
    })
  }
)

it.each([
  { tail: '', sourceEmpty: true, items: 0 },
  { tail: '{"type":"future-metadata"}', sourceEmpty: true, items: 0 },
  { tail: '{"message":{"role":"user","content":"existing prompt"}}', sourceEmpty: false, items: 0 },
  {
    tail: '{"type":"future-turn","message":{"role":"user","content":"existing prompt"}}',
    sourceEmpty: false,
    items: 0
  },
  { tail: '{"type":"summary","message":null}', sourceEmpty: false, items: 0 },
  { tail: '{"type":"user","uuid":"u1"}', sourceEmpty: false, items: 0 },
  { tail: '{"type":""}', sourceEmpty: false, items: 0 },
  { tail: '{}', sourceEmpty: false, items: 0 },
  { tail: 'null', sourceEmpty: false, items: 0 },
  { tail: '{"type":"user","message":{"role":"us', sourceEmpty: false, items: 0 },
  {
    tail: '{"type":"user","isMeta":true,"message":{"role":"user","content":"<local-command-caveat>Local command</local-command-caveat>"}}',
    sourceEmpty: true,
    items: 0
  },
  {
    tail: '{"type":"user","isMeta":true,"message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"saved output"}]}}',
    sourceEmpty: false,
    items: 1,
    shows: 'saved output'
  },
  {
    tail: '{"type":"user","message":{"role":"user","content":"<command-name>/rename</command-name>"}}',
    sourceEmpty: false,
    items: 1,
    shows: '<command-name>/rename</command-name>'
  },
  {
    tail: '{"type":"system","subtype":"local_command","uuid":"lc1","commandRun":{"command":"recap","args":""},"content":"<local-command-stdout>Session recap text</local-command-stdout>"}',
    sourceEmpty: false,
    items: 1,
    shows: 'Session recap text'
  },
  {
    tail: '{"type":"system","subtype":"local_command","uuid":"lc3","commandRun":{"command":"model","args":""},"content":"<local-command-stdout>Kept model as Opus</local-command-stdout>"}',
    sourceEmpty: true,
    items: 0
  },
  {
    tail: '{"type":"user","message":{"role":"user","content":[{"type":"future-content","text":"existing prompt"}]}}',
    sourceEmpty: false,
    items: 0
  }
])(
  'reads a Claude file nothing was sent in as empty, unlike one with a turn it cannot decode: %j',
  async ({
    tail,
    sourceEmpty,
    items,
    shows
  }: {
    tail: string
    sourceEmpty: boolean
    items: number
    shows?: string
  }) => {
    const filePath = join(root, 'claude-unused.jsonl')
    const metadata = [
      { type: 'file-history-snapshot', messageId: 'm1', snapshot: { trackedFileBackups: {} } },
      {
        type: 'summary',
        summary: 'New session',
        leafUuid: 'l1',
        cwd: root,
        sessionId: 'claude-unused'
      }
    ]
    await writeFile(filePath, `${[...metadata.map((m) => JSON.stringify(m)), tail].join('\n')}\n`)
    // Adoption always names the conversation it expects, as Continue in Chat's create does.
    const source = { providerSessionId: 'claude-unused', workspaceCwd: root }
    const prepared = await prepareLegacyTranscriptImport({
      agent: 'claude',
      sessionId: 'claude-unused',
      options: { filePath, source }
    })
    expect(prepared.ok).toBe(true)
    expect(prepared.ok && prepared.items.length).toBe(items)
    if (shows) {
      expect(JSON.stringify(prepared.ok && prepared.items)).toContain(shows)
    }
    expect(prepared.ok && prepared.sourceEmpty).toBe(sourceEmpty)
  }
)

const longWorktree = 'w'.repeat(220)

it.each([
  { worktree: 'moved-worktree', bucketCwd: 'moved-worktree', ok: true },
  { worktree: 'moved-worktree', bucketCwd: 'elsewhere', ok: false },
  // Claude Code names a bucket past 200 characters `<first 200>-<hash>`.
  { worktree: longWorktree, bucketCwd: longWorktree, hashed: true, ok: true }
])(
  'adopts a moved Claude conversation only from the workspace project bucket: %j',
  async ({ worktree, bucketCwd, hashed, ok }) => {
    const workspaceCwd = join(root, worktree)
    const encoded = encodeClaudeProjectPath(join(root, bucketCwd))
    const bucketDir = join(root, 'projects', hashed ? `${encoded.slice(0, 200)}-1a2b3c` : encoded)
    await mkdir(workspaceCwd)
    await mkdir(bucketDir, { recursive: true })
    const filePath = join(bucketDir, 'claude-moved.jsonl')
    // Saved lines keep the cwd the chat started in before its worktree moved.
    await writeFile(
      filePath,
      `${JSON.stringify({
        type: 'user',
        uuid: 'u1',
        cwd: join(root, 'original-worktree'),
        sessionId: 'claude-moved',
        message: { role: 'user', content: 'hello' }
      })}\n`
    )
    const prepared = await prepareLegacyTranscriptImport({
      agent: 'claude',
      sessionId: 'claude-moved',
      options: { filePath, source: { providerSessionId: 'claude-moved', workspaceCwd } }
    })
    expect(prepared).toMatchObject(
      ok
        ? { ok: true }
        : {
            ok: false,
            cause: {
              refusal: {
                code: 'agent_session_identity_required',
                details: { reason: 'transcriptUnreadable', otherFolder: true }
              }
            }
          }
    )
    // Continue in Chat UI asks this before closing the terminal; it must agree with the import.
    const preflight = resolveAdoptedTranscriptFolder({
      agent: 'claude',
      filePath,
      source: { providerSessionId: 'claude-moved', workspaceCwd }
    })
    await (ok
      ? expect(preflight).resolves.toBe(workspaceCwd)
      : expect(preflight).rejects.toMatchObject({
          refusal: { code: 'agent_session_identity_required', details: { otherFolder: true } }
        }))
  }
)

it.each([
  { bucketCwd: 'moved-worktree', ok: true },
  { bucketCwd: 'elsewhere', ok: false }
])(
  'adopts a moved Grok conversation only from the workspace session bucket: %j',
  async ({ bucketCwd, ok }) => {
    const workspaceCwd = join(root, 'moved-worktree')
    const bucket = grokEncodedCwdDirName(join(root, bucketCwd)) ?? ''
    const sessionDir = join(root, 'sessions', bucket, 'grok-moved')
    await mkdir(workspaceCwd)
    await mkdir(sessionDir, { recursive: true })
    await writeFile(
      join(sessionDir, 'summary.json'),
      JSON.stringify({ info: { id: 'grok-moved', cwd: join(root, 'original-worktree') } })
    )
    const filePath = join(sessionDir, 'chat_history.jsonl')
    await writeFile(filePath, `${JSON.stringify({ type: 'user', content: 'hello' })}\n`)
    const prepared = await prepareLegacyTranscriptImport({
      agent: 'grok',
      sessionId: 'grok-moved',
      options: { filePath, source: { providerSessionId: 'grok-moved', workspaceCwd } }
    })
    expect(prepared.ok).toBe(ok)
  }
)

it.each([
  { saved: 'pkg/app', folder: 'pkg/app' },
  { saved: '', folder: '' },
  { saved: '../elsewhere', folder: null }
])(
  'resumes a Pi conversation in the workspace folder it was saved in: %j',
  async ({ saved, folder }) => {
    const workspaceCwd = join(root, 'workspace')
    const cwd = join(workspaceCwd, saved)
    await mkdir(workspaceCwd)
    await mkdir(cwd, { recursive: true })
    const id = '01a1ff56-0a97-7640-8168-f0b025754e71'
    const filePath = join(root, `2026-11-21T18-19-51-319Z_${id}.jsonl`)
    await writeFile(
      filePath,
      `${[
        { type: 'session', version: 3, id, cwd },
        {
          type: 'message',
          id: 'u1',
          parentId: null,
          timestamp: '2026-11-21T18:19:52.000Z',
          message: { role: 'user', content: 'hello' }
        }
      ]
        .map((line) => JSON.stringify(line))
        .join('\n')}\n`
    )
    const resolved = resolveAdoptedTranscriptFolder({
      agent: 'pi',
      filePath,
      source: { providerSessionId: id, workspaceCwd }
    })
    if (folder === null) {
      await expect(resolved).rejects.toMatchObject({
        refusal: { code: 'agent_session_identity_required', details: { otherFolder: true } }
      })
      return
    }
    const expected = join(workspaceCwd, folder)
    await expect(resolved).resolves.toBe(expected)
    // Create imports against the folder it resolved, so the import agrees with the listing.
    const prepared = await prepareLegacyTranscriptImport({
      agent: 'pi',
      sessionId: id,
      options: { filePath, source: { providerSessionId: id, workspaceCwd: expected } }
    })
    expect(prepared.ok).toBe(true)
  }
)
