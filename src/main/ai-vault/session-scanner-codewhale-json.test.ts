import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AiVaultScanIssue } from '../../shared/ai-vault-types'
import { codeWhaleDiscoveries } from './session-scanner-codewhale-sources'
import { parseCodeWhaleSessionFile } from './session-scanner-codewhale-json'
import type { FileWithMtime } from './session-scanner-types'

let tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true })
  }
  tempDirs = []
})

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'orca-codewhale-json-'))
  tempDirs.push(root)
  return root
}

function writeCodeWhaleSession(
  sessionsDir: string,
  args: {
    id?: string
    title?: string
    workspace?: string
    messages?: unknown[]
  } = {}
): string {
  mkdirSync(sessionsDir, { recursive: true })
  const id = args.id ?? 'cw-session'
  const filePath = join(sessionsDir, `${id}.json`)
  writeFileSync(
    filePath,
    JSON.stringify({
      schema_version: 1,
      metadata: {
        id,
        title: args.title ?? 'CodeWhale title',
        created_at: '2026-06-29T16:41:50.046555Z',
        updated_at: '2026-06-29T16:42:37.515855Z',
        message_count: args.messages?.length ?? 4,
        total_tokens: 49413,
        model: 'deepseek-v4-pro',
        workspace: args.workspace ?? '/tmp/codewhale'
      },
      messages: args.messages ?? [
        { role: 'user', content: [{ type: 'text', text: 'Plan CodeWhale Vault' }] },
        { role: 'assistant', content: [{ type: 'thinking', thinking: 'Working it out' }] },
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'CodeWhale reply' }]
        },
        {
          role: 'user',
          content: [{ type: 'tool_result', content: 'tool output' }]
        }
      ],
      system_prompt: 'system'
    }),
    'utf-8'
  )
  return filePath
}

function fileWithMtime(path: string): FileWithMtime {
  const fileStat = statSync(path)
  return { path, mtimeMs: fileStat.mtimeMs, modifiedAt: fileStat.mtime.toISOString() }
}

describe('codeWhaleDiscoveries', () => {
  it('discovers top-level saved session JSON files without scanning artifacts', async () => {
    const root = makeRoot()
    const sessionsDir = join(root, 'codewhale-home', 'sessions')
    const sessionPath = writeCodeWhaleSession(sessionsDir, { id: 'session-one' })
    const artifactDir = join(sessionsDir, 'session-one', 'artifacts')
    mkdirSync(artifactDir, { recursive: true })
    writeFileSync(join(artifactDir, 'artifact.json'), '{}', 'utf-8')
    const issues: AiVaultScanIssue[] = []

    const [discovery] = await Promise.all(
      codeWhaleDiscoveries({ codeWhaleSessionsDir: sessionsDir }, [], 10, issues)
    )

    expect(issues).toEqual([])
    expect(discovery.files.map((file) => file.path)).toEqual([sessionPath])
    expect(discovery.codeWhaleHome).toBe(join(root, 'codewhale-home'))
  })
})

describe('parseCodeWhaleSessionFile', () => {
  it('builds an AI Vault session from CodeWhale saved-session JSON', async () => {
    const root = makeRoot()
    const codeWhaleHome = join(root, 'codewhale-home')
    const sessionPath = writeCodeWhaleSession(join(codeWhaleHome, 'sessions'), {
      id: 'cw-thread',
      workspace: '/tmp/codewhale'
    })

    const session = await parseCodeWhaleSessionFile(
      fileWithMtime(sessionPath),
      'darwin',
      codeWhaleHome
    )

    expect(session).toMatchObject({
      agent: 'codewhale',
      sessionId: 'cw-thread',
      title: 'CodeWhale title',
      cwd: '/tmp/codewhale',
      model: 'deepseek-v4-pro',
      totalTokens: 49413,
      messageCount: 4,
      filePath: sessionPath,
      codeWhaleHome,
      resumeCommand:
        "cd '/tmp/codewhale' && CODEWHALE_HOME='" +
        codeWhaleHome +
        "' codewhale --mouse-capture resume 'cw-thread'"
    })
    expect(session!.previewMessages.map((message) => message.text)).toEqual([
      'Plan CodeWhale Vault',
      'CodeWhale reply',
      'tool output'
    ])
  })

  it('falls back to the first user message when metadata has no title', async () => {
    const root = makeRoot()
    const sessionPath = writeCodeWhaleSession(join(root, 'sessions'), {
      id: 'untitled',
      title: '',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Use this as title' }] }]
    })

    const session = await parseCodeWhaleSessionFile(fileWithMtime(sessionPath), 'darwin', root)

    expect(session?.title).toBe('Use this as title')
  })
})
