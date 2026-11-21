/**
 * Issue #8742 — Antigravity CLI sessions missing from AI Vault history.
 *
 * 1. Discovery scans only ~/.gemini/tmp (Gemini CLI), not
 *    ~/.gemini/antigravity-cli/brain/<id>/.system_generated/logs/transcript.jsonl
 * 2. Gemini JSONL parser only counts type === 'user' | 'gemini'; Antigravity
 *    uses USER_INPUT / PLANNER_RESPONSE / GENERIC with created_at.
 *
 * Re-run:
 *   pnpm exec vitest run --config config/vitest.config.ts \
 *     src/main/ai-vault/repro-8742-antigravity-not-scanned.test.ts
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parseGeminiSessionContent } from './session-scanner-gemini-parsers'

const discoverySource = readFileSync(join(__dirname, 'session-scanner-source-discovery.ts'), 'utf8')
const geminiParserSource = readFileSync(
  join(__dirname, 'session-scanner-gemini-parsers.ts'),
  'utf8'
)

const tmpRoots: string[] = []

afterEach(() => {
  for (const root of tmpRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('issue #8742 Antigravity sessions not detected in AI Vault', () => {
  it('discovers Gemini under ~/.gemini/tmp only — no antigravity-cli brain path', () => {
    expect(discoverySource).toMatch(/\.gemini['"],\s*['"]tmp['"]/)
    expect(discoverySource).toMatch(
      /GEMINI_SESSIONS_DIR\s*=\s*join\(homedir\(\),\s*'\.gemini',\s*'tmp'\)/
    )
    expect(discoverySource).not.toMatch(/antigravity-cli/)
    expect(discoverySource).not.toMatch(/antigravity/)
    expect(discoverySource).not.toMatch(/\.system_generated/)
    // Agent enum may list antigravity elsewhere, but vault discovery has no agent: 'antigravity'
    expect(discoverySource).not.toMatch(/agent:\s*'antigravity'/)
  })

  it('Gemini JSONL consumer only recognizes type user/gemini', () => {
    expect(geminiParserSource).toMatch(/record\.type === 'user'/)
    expect(geminiParserSource).toMatch(/record\.type === 'gemini'/)
    expect(geminiParserSource).not.toMatch(/USER_INPUT/)
    expect(geminiParserSource).not.toMatch(/PLANNER_RESPONSE/)
    expect(geminiParserSource).not.toMatch(/created_at/)
  })

  it('parseGeminiSessionContent drops Antigravity transcript schema (0 messages)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-repro-8742-'))
    tmpRoots.push(root)
    const path = join(root, 'transcript.jsonl')
    // Real Antigravity CLI schema (fields observed under antigravity-cli/brain).
    const lines = [
      JSON.stringify({
        step_index: 0,
        source: 'USER_EXPLICIT',
        type: 'USER_INPUT',
        status: 'DONE',
        created_at: '2026-05-28T02:41:13Z',
        content: '<USER_REQUEST>\nfix the issue card\n</USER_REQUEST>'
      }),
      JSON.stringify({
        step_index: 2,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: '2026-05-28T02:41:13Z',
        tool_calls: [{ name: 'list_permissions', args: {} }]
      }),
      JSON.stringify({
        step_index: 3,
        source: 'MODEL',
        type: 'GENERIC',
        status: 'DONE',
        created_at: '2026-05-28T02:41:14Z',
        content: 'Working on it…'
      })
    ]
    writeFileSync(path, lines.join('\n'))

    const session = await parseGeminiSessionContent(
      {
        path,
        mtimeMs: Date.now(),
        modifiedAt: new Date().toISOString(),
        sizeBytes: 100
      },
      lines.join('\n'),
      'darwin'
    )

    // Parser does not crash, but never counts USER_INPUT / PLANNER_RESPONSE.
    // finalizeSession may return null when messageCount is 0.
    if (session) {
      expect(session.messageCount).toBe(0)
    } else {
      expect(session).toBeNull()
    }
  })

  it('same parser accepts Gemini-shaped user/gemini records', async () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-repro-8742-gemini-'))
    tmpRoots.push(root)
    const path = join(root, 'session.jsonl')
    const lines = [
      JSON.stringify({
        type: 'user',
        timestamp: '2026-05-28T02:41:13Z',
        content: 'hello from gemini cli'
      }),
      JSON.stringify({
        type: 'gemini',
        timestamp: '2026-05-28T02:41:14Z',
        content: 'hi',
        model: 'gemini-2.0'
      })
    ]
    writeFileSync(path, lines.join('\n'))
    const session = await parseGeminiSessionContent(
      {
        path,
        mtimeMs: Date.now(),
        modifiedAt: new Date().toISOString(),
        sizeBytes: 50
      },
      lines.join('\n'),
      'darwin'
    )
    expect(session).not.toBeNull()
    expect(session!.messageCount).toBe(2)
    expect(session!.title).toContain('hello from gemini cli')
  })

  it('even if root were antigravity brain, default discovery would not target transcript.jsonl under .system_generated specially', () => {
    // walkSessionFiles does enter dot-directories (no hidden filter), so path
    // + schema are the primary blockers — prove path is wrong first.
    const brainRoot = join('HOME', '.gemini', 'antigravity-cli', 'brain')
    const expectedTranscript = join(
      brainRoot,
      '9d820cf9-f043-4172-9a56-818fe3225253',
      '.system_generated',
      'logs',
      'transcript.jsonl'
    )
    expect(expectedTranscript).toContain('antigravity-cli')
    expect(expectedTranscript).toContain('.system_generated')
    expect(discoverySource).not.toContain('antigravity-cli')
  })
})
