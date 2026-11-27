import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readAiVaultSessionTitlesFromFiles } from './session-title-file-reader'

const SESSION_ID = '4bacae20-42e2-420c-9e44-af14ffc469f3'
let root: string | undefined

afterEach(async () => {
  if (root) {
    await rm(root, { recursive: true, force: true })
    root = undefined
  }
})

function userTurn(content: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: 'user',
    sessionId: SESSION_ID,
    cwd: '/repo/app',
    timestamp: '2026-11-08T10:00:00.000Z',
    ...extra,
    message: { role: 'user', content }
  })
}

async function readTitles(lines: string[]) {
  root = await mkdtemp(join(tmpdir(), 'orca-harness-title-'))
  const transcriptPath = join(root, `${SESSION_ID}.jsonl`)
  await writeFile(transcriptPath, `${lines.join('\n')}\n`)
  const result = await readAiVaultSessionTitlesFromFiles([
    { agent: 'claude', sessionId: SESSION_ID, transcriptPath }
  ])
  return result.titles.map(({ title, kind }) => ({ title, kind }))
}

describe('Claude session titles from harness turns', () => {
  // /clear starts a transcript holding only harness turns; neither they nor the
  // "Claude 4bacae20" id placeholder name the session, so the tab keeps its live title.
  it('gives a transcript holding only a local command no title', async () => {
    const titles = await readTitles([
      JSON.stringify({ type: 'mode', sessionId: SESSION_ID }),
      userTurn(
        '<local-command-caveat>The command below was run directly in Claude Code, not sent to you as a request.</local-command-caveat>',
        { isMeta: true }
      ),
      userTurn(
        '<command-name>/clear</command-name>\n<command-message>clear</command-message>\n<command-args></command-args>'
      )
    ])

    expect(titles).toEqual([])
  })

  it.each([
    {
      name: 'a prompt command, not its expansion',
      lines: [
        userTurn(
          '<command-name>/goal</command-name>\n<command-message>goal</command-message>\n<command-args>ship the fix</command-args>'
        ),
        userTurn('<local-command-stdout>Goal set: ship the fix</local-command-stdout>'),
        userTurn('A session-scoped Stop hook is now active with condition: "ship the fix"', {
          isMeta: true
        })
      ],
      title: '/goal ship the fix'
    },
    {
      name: 'a skill, not its base directory',
      lines: [
        userTurn(
          '<command-message>ref-oss</command-message>\n<command-name>/ref-oss</command-name>\n<command-args>ghostty tabs</command-args>'
        ),
        userTurn('Base directory for this skill: /home/me/.claude/skills/ref-oss', { isMeta: true })
      ],
      title: '/ref-oss ghostty tabs'
    },
    {
      name: "a teammate's task",
      lines: [
        userTurn(
          '<teammate-message teammate_id="team-lead" summary="Fix tests">\nFix the failing palette tests\n</teammate-message>'
        )
      ],
      title: 'Fix the failing palette tests'
    }
  ])('names a session by $name', async ({ lines, title }) => {
    expect(await readTitles(lines)).toEqual([{ title, kind: 'fallback' }])
  })
})
