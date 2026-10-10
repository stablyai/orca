import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  KIRO_V3_FIXTURE_MANIFEST,
  KIRO_V3_FIXTURE_SESSION_ID,
  writeKiroV3SessionFixture
} from './session-scanner-kiro-fixtures'
import {
  isKiroV3SessionManifestPath,
  kiroV3SessionDirectoryPredicate,
  kiroV3TranscriptPathForManifest,
  parseKiroV3SessionContent,
  parseKiroV3SessionFile
} from './session-scanner-kiro-v3-parser'
import type { FileWithMtime } from './session-scanner-types'

let tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })))
  tempDirs = []
})

const fileAt = (path: string): FileWithMtime => {
  const mtimeMs = Date.parse('2026-10-02T16:04:35.400Z')
  return { path, mtimeMs, modifiedAt: new Date(mtimeMs).toISOString() }
}

async function writeKiroSession(
  options: Parameters<typeof writeKiroV3SessionFixture>[1] = {}
): Promise<{ file: FileWithMtime }> {
  const root = await mkdtemp(join(tmpdir(), 'orca-kiro-vault-'))
  tempDirs.push(root)
  return { file: fileAt(await writeKiroV3SessionFixture(root, options)) }
}

describe('parseKiroV3SessionFile', () => {
  it('returns null for a malformed session.json', async () => {
    const { file } = await writeKiroSession()
    await writeFile(file.path, '{not-json')

    await expect(parseKiroV3SessionFile(file, 'darwin')).resolves.toBeNull()
  })

  it('parses the manifest and the user/assistant turns of the transcript', async () => {
    const { file } = await writeKiroSession()
    const session = await parseKiroV3SessionFile(file, 'darwin')

    expect(session?.agent).toBe('kiro')
    expect(session?.sessionId).toBe(KIRO_V3_FIXTURE_SESSION_ID)
    expect(session?.title).toBe('Execute PowerShell Sleep Command')
    expect(session?.cwd).toBe('/private/tmp/kiro-test-proj')
    expect(session?.model).toBe('claude-opus-5.5')
    // Reasoning and Summary entries are not replies the user saw.
    expect(session?.messageCount).toBe(2)
    expect(session?.previewMessages).toEqual([
      {
        role: 'user',
        text: 'Run the shell command: echo dev-ok',
        timestamp: '2026-10-02T16:04:12.300Z'
      },
      { role: 'assistant', text: 'done', timestamp: '2026-10-02T16:04:30.000Z' }
    ])
    expect(session?.createdAt).toBe('2026-10-02T16:04:12.112Z')
  })

  it('builds a workspace-scoped resume command through the chat subcommand', async () => {
    const { file } = await writeKiroSession()
    const session = await parseKiroV3SessionFile(file, 'darwin')

    expect(session?.resumeCommand).toBe(
      `cd '/private/tmp/kiro-test-proj' && kiro-cli chat --tui --resume-id '${KIRO_V3_FIXTURE_SESSION_ID}'`
    )
  })

  it('resumes by the validated directory name when the manifest id disagrees', async () => {
    const { file } = await writeKiroSession({
      manifest: { ...KIRO_V3_FIXTURE_MANIFEST, id: "sess_x'; rm -rf ~; '" }
    })
    const session = await parseKiroV3SessionFile(file, 'darwin')

    expect(session?.sessionId).toBe(KIRO_V3_FIXTURE_SESSION_ID)
    expect(session?.resumeCommand).toContain(`--resume-id '${KIRO_V3_FIXTURE_SESSION_ID}'`)
  })

  it('surfaces an unreadable manifest instead of answering "no session"', async () => {
    const { file } = await writeKiroSession()
    await rm(file.path)
    await mkdir(file.path)

    await expect(parseKiroV3SessionFile(file, 'darwin')).rejects.toThrow()
  })

  it('surfaces an unreadable transcript instead of listing a partial session', async () => {
    const { file } = await writeKiroSession({ messageLines: null })
    await mkdir(join(dirname(file.path), 'messages.jsonl'))

    await expect(parseKiroV3SessionFile(file, 'darwin')).rejects.toThrow()
  })

  it('still lists a session that has no transcript yet', async () => {
    const { file } = await writeKiroSession({ messageLines: null })
    const session = await parseKiroV3SessionFile(file, 'darwin')

    expect(session?.title).toBe('Execute PowerShell Sleep Command')
    expect(session?.messageCount).toBe(0)
  })

  it('falls back to the first prompt when the manifest has no title', async () => {
    const { file } = await writeKiroSession({
      manifest: { ...KIRO_V3_FIXTURE_MANIFEST, title: '' }
    })
    const session = await parseKiroV3SessionFile(file, 'darwin')

    expect(session?.title).toBe('Run the shell command: echo dev-ok')
  })
})

describe('parseKiroV3SessionContent', () => {
  const manifestPath = `/home/u/.kiro/sessions/5fab923ac92fb45c/${KIRO_V3_FIXTURE_SESSION_ID}/session.json`

  it('parses streamed lines with the execution host attached', async () => {
    const session = await parseKiroV3SessionContent(
      fileAt(manifestPath),
      JSON.stringify(KIRO_V3_FIXTURE_MANIFEST),
      [JSON.stringify({ payload: { type: 'user', content: 'hello' } })],
      'linux',
      { executionHostId: 'ssh:kiro-host', executionHostPlatform: 'linux' }
    )

    expect(session).toMatchObject({
      sessionId: KIRO_V3_FIXTURE_SESSION_ID,
      messageCount: 1,
      executionHostId: 'ssh:kiro-host'
    })
  })

  it('keeps a manifest-only session when the transcript is absent', async () => {
    const session = await parseKiroV3SessionContent(
      fileAt(manifestPath),
      JSON.stringify(KIRO_V3_FIXTURE_MANIFEST),
      null,
      'linux'
    )

    expect(session?.messageCount).toBe(0)
  })
})

describe('Kiro V3 session paths', () => {
  it('matches only session.json inside a sess_<uuid> directory', () => {
    const sessionDir = join('h', KIRO_V3_FIXTURE_SESSION_ID)
    expect(isKiroV3SessionManifestPath(join(sessionDir, 'session.json'))).toBe(true)
    expect(isKiroV3SessionManifestPath(join(sessionDir, 'messages.jsonl'))).toBe(false)
    expect(isKiroV3SessionManifestPath(join('h', 'sess_not-a-uuid', 'session.json'))).toBe(false)
    expect(isKiroV3SessionManifestPath(join('cli', '00a05f6b.json'))).toBe(false)
  })

  it.each([
    `C:\\Users\\Ada\\.kiro\\sessions\\5fab923ac92fb45c\\${KIRO_V3_FIXTURE_SESSION_ID}\\session.json`,
    `\\\\wsl.localhost\\Ubuntu\\home\\ada\\.kiro\\sessions\\h\\${KIRO_V3_FIXTURE_SESSION_ID}\\session.json`,
    `C:/Users/Ada/.kiro/sessions/5fab923ac92fb45c/${KIRO_V3_FIXTURE_SESSION_ID}/session.json`,
    `/home/ada/.kiro/sessions/5fab923ac92fb45c/${KIRO_V3_FIXTURE_SESSION_ID}/session.json`
  ])('keeps the separators of %s for the sibling transcript', (manifestPath) => {
    expect(isKiroV3SessionManifestPath(manifestPath)).toBe(true)
    expect(kiroV3TranscriptPathForManifest(manifestPath)).toBe(
      manifestPath.replace(/session\.json$/, 'messages.jsonl')
    )
  })

  it('walks only workspace-hash and sess_<uuid> directories', () => {
    expect(kiroV3SessionDirectoryPredicate('5fab923ac92fb45c', 0)).toBe(true)
    expect(kiroV3SessionDirectoryPredicate('cli', 0)).toBe(false)
    expect(kiroV3SessionDirectoryPredicate('.index', 0)).toBe(false)
    expect(kiroV3SessionDirectoryPredicate('0b5e1c2a-3d4f-4a5b-8c6d-7e8f9a0b1c2d', 0)).toBe(false)
    expect(kiroV3SessionDirectoryPredicate(KIRO_V3_FIXTURE_SESSION_ID, 1)).toBe(true)
    expect(kiroV3SessionDirectoryPredicate('.index', 1)).toBe(false)
    expect(kiroV3SessionDirectoryPredicate('tasks', 2)).toBe(false)
  })
})
