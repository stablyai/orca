import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  appendFileSync,
  copyFileSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import type * as NodeOs from 'node:os'
import type * as FsPromises from 'node:fs/promises'
import { join } from 'node:path'

const { home, nativeReadRefusal } = vi.hoisted(() => {
  const nativeReadRefusal: { path: string | null } = { path: null }
  return { home: vi.fn<() => string>(), nativeReadRefusal }
})
vi.mock('node:os', async () => ({
  ...(await vi.importActual<typeof NodeOs>('node:os')),
  homedir: home
}))
vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof FsPromises>('node:fs/promises')
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      if (args[0] === nativeReadRefusal.path) {
        throw Object.assign(new Error('Native history cannot be reopened'), { code: 'EACCES' })
      }
      return actual.open(...args)
    }
  }
})

import { scanCodexUsageFiles } from './scanner'
import { filterUsageDaily } from '../usage/usage-scope-filters'
import type { CodexUsageSourceDiscovery } from './codex-usage-sources'

let root: string
let previousUserData: string | undefined
const cwd = '/home/be0h/projects/CXETCPP'
const worktree = {
  repoId: 'cxet',
  worktreeId: 'cxet::wsl-cxet',
  path: String.raw`\\wsl.localhost\Ubuntu-24.04\home\be0h\projects\CXETCPP`,
  displayName: 'CXETCPP'
}

function usage(timestamp: string, tokens: number, total = tokens) {
  return `${JSON.stringify({
    timestamp,
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        last_token_usage: {
          input_tokens: tokens,
          cached_input_tokens: 0,
          output_tokens: 0,
          total_tokens: tokens
        },
        total_token_usage: {
          input_tokens: total,
          cached_input_tokens: 0,
          output_tokens: 0,
          total_tokens: total
        }
      }
    }
  })}\n`
}

function rollout(
  directory: string,
  session: string,
  location = cwd,
  timestamp = '2026-11-08T10:00:00Z'
) {
  mkdirSync(directory, { recursive: true })
  const file = join(directory, `${session}.jsonl`)
  writeFileSync(
    file,
    `${JSON.stringify({ type: 'session_meta', payload: { id: session, cwd: location } })}\n${JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-5-codex', cwd: location } })}\n${usage(timestamp, 120)}`
  )
  return file
}

function source(distro = 'Ubuntu-24.04'): CodexUsageSourceDiscovery {
  return {
    sources: [{ directory: join(root, distro, 'sessions'), distro }],
    wslHomes: [join(root, distro)],
    complete: true
  }
}

beforeEach(() => {
  nativeReadRefusal.path = null
  root = mkdtempSync(join(tmpdir(), 'orca-codex-wsl-usage-'))
  home.mockReturnValue(join(root, 'native'))
  previousUserData = process.env.ORCA_USER_DATA_PATH
  process.env.ORCA_USER_DATA_PATH = join(root, 'orca')
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  if (previousUserData === undefined) {
    delete process.env.ORCA_USER_DATA_PATH
  } else {
    process.env.ORCA_USER_DATA_PATH = previousUserData
  }
})

describe('Codex usage from WSL sources', () => {
  it('updates an unrelated WSL session when unchanged native history cannot be reopened', async () => {
    const discovery = source()
    const native = rollout(
      join(root, 'native', '.codex', 'sessions'),
      'native-session',
      '/native/project'
    )
    const wsl = rollout(discovery.sources[0].directory, 'wsl-session', cwd, '2026-11-08T10:00:01Z')
    const first = await scanCodexUsageFiles([worktree], [], undefined, discovery)
    nativeReadRefusal.path = native
    appendFileSync(wsl, usage('2026-11-08T10:01:00Z', 30, 150))

    const result = await scanCodexUsageFiles([worktree], first.processedFiles, undefined, discovery)
    expect(
      result.sessions.find((session) => session.sessionId === 'native-session')?.totalTokens
    ).toBe(120)
    expect(filterUsageDaily(result.dailyAggregates, 'orca', 'all')).toMatchObject([
      { worktreeId: 'cxet::wsl-cxet', totalTokens: 150 }
    ])
    expect(result.sessions.reduce((total, session) => total + session.totalTokens, 0)).toBe(270)
  })

  it.each([
    ['copy', false],
    ['copy', true],
    ['hardlink', false],
    ['hardlink', true]
  ] as const)('prefers WSL attribution for a native %s with warm cache=%s', async (kind, warm) => {
    const discovery = source()
    const native = rollout(join(root, 'native', '.codex', 'sessions'), 'shared-session')
    const previous = warm ? await scanCodexUsageFiles([worktree], []) : null
    mkdirSync(discovery.sources[0].directory, { recursive: true })
    const target = join(discovery.sources[0].directory, 'shared-session.jsonl')
    if (kind === 'copy') {
      copyFileSync(native, target)
    } else {
      linkSync(native, target)
    }

    const result = await scanCodexUsageFiles(
      [worktree],
      previous?.processedFiles ?? [],
      undefined,
      discovery
    )
    expect(
      filterUsageDaily(result.dailyAggregates, 'all', 'all').map((day) => day.totalTokens)
    ).toEqual([120])
    expect(filterUsageDaily(result.dailyAggregates, 'orca', 'all')).toMatchObject([
      { worktreeId: 'cxet::wsl-cxet', totalTokens: 120 }
    ])
    const repeated = await scanCodexUsageFiles(
      [worktree],
      result.processedFiles,
      undefined,
      discovery
    )
    expect(filterUsageDaily(repeated.dailyAggregates, 'orca', 'all')).toMatchObject([
      { worktreeId: 'cxet::wsl-cxet', totalTokens: 120 }
    ])
  })

  it('includes WSL usage in both all and Orca scope without changing native attribution', async () => {
    const discovery = source()
    rollout(discovery.sources[0].directory, 'wsl-session')
    rollout(
      join(root, 'native', '.codex', 'sessions'),
      'native-session',
      '/native/project',
      '2026-11-08T10:00:01Z'
    )

    const result = await scanCodexUsageFiles([worktree], [], undefined, discovery)
    expect(
      filterUsageDaily(result.dailyAggregates, 'all', 'all').map((day) => day.totalTokens)
    ).toEqual([120, 120])
    expect(filterUsageDaily(result.dailyAggregates, 'orca', 'all')).toMatchObject([
      { worktreeId: 'cxet::wsl-cxet', totalTokens: 120 }
    ])
    expect(
      result.sessions.find((session) => session.sessionId === 'native-session')?.primaryWorktreeId
    ).toBeNull()
  })

  it('keeps identical Linux locations in different distros separate and ext4 paths case-sensitive', async () => {
    const ubuntu = source()
    const debian = source('Debian')
    rollout(ubuntu.sources[0].directory, 'ubuntu', `${cwd}/nested`)
    rollout(debian.sources[0].directory, 'debian', `${cwd}/nested`, '2026-11-08T10:00:02Z')
    rollout(
      ubuntu.sources[0].directory,
      'different-case',
      '/home/be0h/projects/cxetcpp/nested',
      '2026-11-08T10:00:03Z'
    )
    const result = await scanCodexUsageFiles([worktree], [], undefined, {
      sources: [...ubuntu.sources, ...debian.sources],
      wslHomes: [...ubuntu.wslHomes, ...debian.wslHomes],
      complete: true
    })
    expect(
      result.sessions.find((session) => session.sessionId === 'ubuntu')?.primaryWorktreeId
    ).toBe('cxet::wsl-cxet')
    expect(
      result.sessions.find((session) => session.sessionId === 'debian')?.primaryWorktreeId
    ).toBeNull()
    expect(
      result.sessions.find((session) => session.sessionId === 'different-case')?.primaryWorktreeId
    ).toBeNull()
    expect(new Set(result.dailyAggregates.map((day) => day.projectKey)).size).toBe(3)
  })

  it('retains unavailable history and reconciles deletion only after a complete accessible scan', async () => {
    const discovery = source()
    const file = rollout(discovery.sources[0].directory, 'session')
    const first = await scanCodexUsageFiles([worktree], [], undefined, discovery)
    const stopped = await scanCodexUsageFiles([worktree], first.processedFiles, undefined, {
      sources: [],
      wslHomes: [],
      complete: true
    })
    expect(stopped.sessions[0]?.totalTokens).toBe(120)
    rmSync(file)
    await expect(
      scanCodexUsageFiles([worktree], stopped.processedFiles, undefined, {
        ...discovery,
        complete: false
      })
    ).rejects.toThrow('WSL Codex usage discovery is unavailable')
    expect(stopped.sessions[0]?.totalTokens).toBe(120)
    const deleted = await scanCodexUsageFiles(
      [worktree],
      stopped.processedFiles,
      undefined,
      discovery
    )
    expect(deleted.sessions).toEqual([])
  })

  it('surfaces an unconfirmed first scan for a WSL workspace instead of reporting empty usage', async () => {
    await expect(
      scanCodexUsageFiles([worktree], [], undefined, {
        sources: [],
        wslHomes: [],
        complete: false
      })
    ).rejects.toThrow('WSL Codex usage discovery is unavailable')
  })

  it('keeps native usage available when WSL is unconfigured and its probe is unavailable', async () => {
    rollout(join(root, 'native', '.codex', 'sessions'), 'native-session', '/native/project')
    const result = await scanCodexUsageFiles([], [], undefined, {
      sources: [],
      wslHomes: [],
      complete: false
    })
    expect(result.sessions).toMatchObject([{ sessionId: 'native-session', totalTokens: 120 }])
  })

  it('adds appended tokens once and does not double-count copied rollouts', async () => {
    const discovery = source()
    const file = rollout(discovery.sources[0].directory, 'session')
    const first = await scanCodexUsageFiles([worktree], [], undefined, discovery)
    appendFileSync(file, usage('2026-11-08T10:01:00Z', 30, 150))
    const second = await scanCodexUsageFiles([worktree], first.processedFiles, undefined, discovery)
    expect(second.sessions[0]?.totalTokens).toBe(150)
    writeFileSync(
      join(discovery.sources[0].directory, 'fork.jsonl'),
      `${JSON.stringify({ type: 'session_meta', payload: { id: 'session', cwd } })}\n${usage('2026-11-08T10:00:00Z', 120)}${usage('2026-11-08T10:01:00Z', 30, 150)}`
    )
    const third = await scanCodexUsageFiles([worktree], second.processedFiles, undefined, discovery)
    expect(third.sessions[0]?.totalTokens).toBe(150)
  })
})
