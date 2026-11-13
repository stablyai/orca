import { mkdir, mkdtemp, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { KIMI_TRANSCRIPT_IMPORT } from './kimi-transcript-import'

const ID = 'session_01234567-89ab-cdef-0123-456789abcdef'
let root = ''
let home = ''
let sessionsDir = ''

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'orca-kimi-import-')))
  home = join(root, '.kimi-code')
  sessionsDir = join(home, 'sessions')
})

afterEach(async () => rm(root, { recursive: true, force: true }))

async function sessionDir(workspace = 'wd_repo_ab12cd34ef56'): Promise<string> {
  const dir = join(sessionsDir, workspace, ID)
  await mkdir(join(dir, 'agents', 'main'), { recursive: true })
  return dir
}

async function writeSession(options: {
  workspace?: string
  primaryAgent?: string
  index?: { sessionDir: string } | null
}): Promise<string> {
  const dir = await sessionDir(options.workspace)
  const agents = { [options.primaryAgent ?? 'main']: { type: 'main', parentAgentId: null } }
  await writeFile(join(dir, 'state.json'), JSON.stringify({ sessionId: ID, agents }))
  const primary = options.primaryAgent ?? 'main'
  await mkdir(join(dir, 'agents', primary), { recursive: true })
  await writeFile(join(dir, 'agents', primary, 'wire.jsonl'), '{}\n')
  if (options.index) {
    await mkdir(home, { recursive: true })
    await writeFile(
      join(home, 'session_index.jsonl'),
      `${JSON.stringify({ sessionId: ID, sessionDir: options.index.sessionDir, workDir: '/repo' })}\n`
    )
  }
  return join(dir, 'agents', primary, 'wire.jsonl')
}

function lookup() {
  const launchEnv = { HOME: root, USERPROFILE: root }
  const store = KIMI_TRANSCRIPT_IMPORT.conversationStore({
    accountHome: { variable: 'KIMI_CODE_HOME', path: home },
    launchEnv
  })
  return store
    ? KIMI_TRANSCRIPT_IMPORT.findTranscript({
        providerSessionId: ID,
        store,
        workspaceCwd: '/repo',
        launchEnv
      })
    : null
}

describe('KIMI_TRANSCRIPT_IMPORT', () => {
  it('resolves the main agent wire through the session index', async () => {
    const wire = await writeSession({
      index: { sessionDir: join(sessionsDir, 'wd_repo_ab12cd34ef56', ID) }
    })
    await expect(lookup()).resolves.toBe(wire)
  })

  it('resolves relative index entries against the data root', async () => {
    const wire = await writeSession({
      index: { sessionDir: join('sessions', 'wd_repo_ab12cd34ef56', ID) }
    })
    await expect(lookup()).resolves.toBe(wire)
  })

  it('follows a non-main primary agent named by state.json', async () => {
    const wire = await writeSession({
      primaryAgent: 'agent-0',
      index: { sessionDir: join(sessionsDir, 'wd_repo_ab12cd34ef56', ID) }
    })
    await expect(lookup()).resolves.toBe(wire)
  })

  it('falls back to the on-disk layout when the index misses', async () => {
    const wire = await writeSession({ index: null })
    await expect(lookup()).resolves.toBe(wire)
  })

  it('returns null when the session has no wire transcript', async () => {
    await writeSession({ index: { sessionDir: join(sessionsDir, 'wd_repo_ab12cd34ef56', ID) } })
    const launchEnv = { HOME: root, USERPROFILE: root }
    const store = KIMI_TRANSCRIPT_IMPORT.conversationStore({
      accountHome: { variable: 'KIMI_CODE_HOME', path: home },
      launchEnv
    })
    if (!store) {
      throw new Error('store expected')
    }
    await rename(
      join(sessionsDir, 'wd_repo_ab12cd34ef56', ID, 'agents', 'main', 'wire.jsonl'),
      join(sessionsDir, 'wd_repo_ab12cd34ef56', ID, 'agents', 'main', 'wire.jsonl.gone')
    )
    await expect(
      KIMI_TRANSCRIPT_IMPORT.findTranscript({
        providerSessionId: ID,
        store,
        workspaceCwd: '/repo',
        launchEnv
      })
    ).resolves.toBeNull()
  })
})
