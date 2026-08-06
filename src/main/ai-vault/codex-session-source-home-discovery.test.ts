import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// Created in vi.hoisted because session-scanner-source-discovery resolves
// ~/.codex at module load, so the fake home must exist before that import runs.
const testHome = vi.hoisted(() => {
  const { mkdtempSync, mkdirSync } = require('node:fs') // eslint-disable-line @typescript-eslint/no-require-imports -- vi.hoisted runs before ESM imports
  const { tmpdir } = require('node:os') // eslint-disable-line @typescript-eslint/no-require-imports -- see above
  const { join: joinPath } = require('node:path') // eslint-disable-line @typescript-eslint/no-require-imports -- see above
  const root: string = mkdtempSync(joinPath(tmpdir(), 'orca-codex-source-home-'))
  const home: string = joinPath(root, 'home')
  mkdirSync(home, { recursive: true })
  process.env.ORCA_USER_DATA_PATH = joinPath(root, 'userdata')
  mkdirSync(process.env.ORCA_USER_DATA_PATH, { recursive: true })
  return { root, home }
})

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os') // eslint-disable-line @typescript-eslint/consistent-type-imports -- vi.importActual requires inline import()
  return { ...actual, homedir: () => testHome.home }
})
vi.mock('../wsl', () => ({
  getWslHomeAsync: vi.fn(),
  listWslDistrosAsync: vi.fn().mockResolvedValue([])
}))

import {
  configureAiVaultSessionSources,
  listAiVaultSessions,
  resetAiVaultSessionListCacheForTests
} from './cached-session-list'
import { jsonLines } from './session-scanner-test-fixtures'

const CUSTOM_HOME = join(testHome.home, '.codex-chatgpt')
const DEFAULT_HOME = join(testHome.home, '.codex')
const RUNTIME_HOME = join(testHome.root, 'userdata', 'codex-runtime-home', 'home')
const CUSTOM_SESSION_TITLE = 'session recorded in the custom Codex home'
const DEFAULT_SESSION_TITLE = 'session recorded in the default Codex home'

async function writeCodexRollout(homePath: string, sessionId: string, text: string): Promise<void> {
  const dayDir = join(homePath, 'sessions', '2026', '08', '01')
  await mkdir(dayDir, { recursive: true })
  await writeFile(
    join(dayDir, `rollout-2026-08-01T10-00-00-${sessionId}.jsonl`),
    jsonLines([
      {
        timestamp: '2026-08-01T10:00:00.000Z',
        type: 'session_meta',
        payload: { id: sessionId, cwd: '/repo/app' }
      },
      {
        timestamp: '2026-08-01T10:00:01.000Z',
        type: 'response_item',
        payload: { type: 'message', role: 'user', content: [{ type: 'text', text }] }
      }
    ])
  )
}

async function listCodexTitles(): Promise<(string | null)[]> {
  const result = await listAiVaultSessions({ force: true, unlimited: true })
  return result.sessions.filter((session) => session.agent === 'codex').map((s) => s.title)
}

beforeAll(async () => {
  await writeCodexRollout(CUSTOM_HOME, '019f0000-1111-7222-8333-aaaaaaaaaaaa', CUSTOM_SESSION_TITLE)
  await writeCodexRollout(
    DEFAULT_HOME,
    '019f0000-1111-7222-8333-bbbbbbbbbbbb',
    DEFAULT_SESSION_TITLE
  )
})

beforeEach(() => {
  resetAiVaultSessionListCacheForTests()
})

// #12186: a user who runs Codex with a custom CODEX_HOME sets the session
// source home in Settings, but Agent History kept scanning ~/.codex only.
describe('Agent History discovery with a configured Codex session source home', () => {
  it('lists sessions from the configured source home and the default home together', async () => {
    configureAiVaultSessionSources({
      getCodexSessionSourceHomePath: () => CUSTOM_HOME,
      // The mirror lane (which every custom-CODEX_HOME user is on) reports only
      // the managed runtime home here — never ~/.codex.
      getAdditionalCodexHomePaths: () => [RUNTIME_HOME]
    })

    const titles = await listCodexTitles()

    expect(titles).toContain(CUSTOM_SESSION_TITLE)
    expect(titles).toContain(DEFAULT_SESSION_TITLE)
  })

  it('lists only the default home when no source home is configured', async () => {
    configureAiVaultSessionSources({ getAdditionalCodexHomePaths: () => [RUNTIME_HOME] })

    const titles = await listCodexTitles()

    expect(titles).toEqual([DEFAULT_SESSION_TITLE])
  })

  it('resumes a configured-source-home session against that home', async () => {
    configureAiVaultSessionSources({ getCodexSessionSourceHomePath: () => CUSTOM_HOME })

    const result = await listAiVaultSessions({ force: true, unlimited: true })
    const custom = result.sessions.find((session) => session.title === CUSTOM_SESSION_TITLE)

    expect(custom?.codexHome).toBe(CUSTOM_HOME)
    expect(custom?.resumeCommand).toContain(`CODEX_HOME='${CUSTOM_HOME}'`)
  })
})
