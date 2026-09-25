import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HandlerContext } from '../dispatch'
import type { RuntimeClient } from '../runtime-client'
import { RuntimeClientError } from '../runtime/types'
import { DIAGNOSTICS_HANDLERS } from './diagnostics'

const DAY = 24 * 60 * 60 * 1000
const roots: string[] = []
let previousUserData: string | undefined

afterEach(() => {
  if (previousUserData === undefined) {
    delete process.env.ORCA_USER_DATA_PATH
  } else {
    process.env.ORCA_USER_DATA_PATH = previousUserData
  }
  previousUserData = undefined
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function useTempUserData(): string {
  previousUserData = process.env.ORCA_USER_DATA_PATH
  const root = mkdtempSync(join(tmpdir(), 'orca-diagnostics-history-'))
  roots.push(root)
  process.env.ORCA_USER_DATA_PATH = root
  return root
}

function context(flags: Map<string, string | boolean>, json: boolean): HandlerContext {
  return {
    flags,
    json,
    cwd: '/tmp',
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the history commands never call the runtime client; the proxy fails the test if they do.
    client: new Proxy({} as RuntimeClient, {
      get() {
        throw new Error('diagnostics history commands must not contact the runtime')
      }
    })
  }
}

describe('diagnostics disk and clear-history-older-than', () => {
  it('reports sizes from the local data directory without contacting the runtime', async () => {
    const root = useTempUserData()
    const sessions = join(root, 'codex-runtime-home', 'home', 'sessions', '2026', '09', '01')
    mkdirSync(sessions, { recursive: true })
    writeFileSync(join(sessions, 'rollout-recent.jsonl'), 'hello')
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    await DIAGNOSTICS_HANDLERS['diagnostics disk'](context(new Map(), false))

    expect(log.mock.calls.flat().join('\n')).toContain('Private Codex sessions')
    expect(log.mock.calls.flat().join('\n')).toContain('rollout files')
    log.mockRestore()
  })

  it('keeps a recent rollout and removes an old one', async () => {
    const root = useTempUserData()
    const sessions = join(root, 'codex-runtime-home', 'home', 'sessions')
    const recentDir = join(sessions, '2026', '09', '01')
    const oldDir = join(sessions, '2026', '05', '01')
    mkdirSync(recentDir, { recursive: true })
    mkdirSync(oldDir, { recursive: true })
    const recent = join(recentDir, 'rollout-recent.jsonl')
    const old = join(oldDir, 'rollout-old.jsonl')
    writeFileSync(recent, 'recent')
    writeFileSync(old, 'old')
    const recentMtime = new Date(Date.now() - 2 * DAY)
    const oldMtime = new Date(Date.now() - 40 * DAY)
    utimesSync(recent, recentMtime, recentMtime)
    utimesSync(old, oldMtime, oldMtime)
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    await DIAGNOSTICS_HANDLERS['diagnostics clear-history-older-than'](
      context(new Map([['days', '30']]), false)
    )

    expect(existsSync(recent)).toBe(true)
    expect(existsSync(old)).toBe(false)
    expect(log.mock.calls.flat().join('\n')).toContain('Kept 1 newer rollouts')
    log.mockRestore()
  })

  it('does not delete on --dry-run', async () => {
    const root = useTempUserData()
    const oldDir = join(root, 'codex-runtime-home', 'home', 'sessions', '2026', '05', '01')
    mkdirSync(oldDir, { recursive: true })
    const old = join(oldDir, 'rollout-old.jsonl')
    writeFileSync(old, 'old')
    const oldMtime = new Date(Date.now() - 40 * DAY)
    utimesSync(old, oldMtime, oldMtime)
    vi.spyOn(console, 'log').mockImplementation(() => {})

    await DIAGNOSTICS_HANDLERS['diagnostics clear-history-older-than'](
      context(
        new Map<string, string | boolean>([
          ['days', '30'],
          ['dry-run', true]
        ]),
        false
      )
    )

    expect(existsSync(old)).toBe(true)
    vi.restoreAllMocks()
  })

  it('rejects a zero-day cutoff', async () => {
    useTempUserData()
    await expect(
      DIAGNOSTICS_HANDLERS['diagnostics clear-history-older-than'](
        context(new Map([['days', '0']]), true)
      )
    ).rejects.toBeInstanceOf(RuntimeClientError)
  })
})
