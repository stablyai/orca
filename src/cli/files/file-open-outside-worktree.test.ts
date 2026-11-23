import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { COMMAND_SPECS } from '../specs/index'
import { normalizeCommandPositionals, parseArgs } from '../arguments/args'
import { specPaths } from '../discovery/command-spec'
import type { HandlerContext } from '../dispatch/dispatch'
import type { RuntimeClient } from '../runtime/client'
import { FILE_HANDLERS } from './file'

const selectorMocks = vi.hoisted(() => ({
  getOptionalWorktreeSelector: vi.fn(),
  resolveCurrentWorktreeSelector: vi.fn()
}))

vi.mock('../workspace-selection/workspace-selector', () => selectorMocks)

const CURRENT = 'id:repoA::/repos/current'
const HOST_ENV = [
  'ORCA_ORCHESTRATION_COMPATIBILITY_HOST_KIND',
  'ORCA_ORCHESTRATION_COMPATIBILITY_HOST_ID',
  'ORCA_ORCHESTRATION_COMPATIBILITY_HOST_INCARNATION',
  'ORCA_ORCHESTRATION_COMPATIBILITY_ATTACHMENT'
] as const

type ListedWorktree = { id: string; path: string; hostId?: string }

const savedEnv = new Map<string, string | undefined>()

beforeEach(() => {
  for (const key of HOST_ENV) {
    savedEnv.set(key, process.env[key])
    delete process.env[key]
  }
  selectorMocks.resolveCurrentWorktreeSelector.mockResolvedValue(CURRENT)
  selectorMocks.getOptionalWorktreeSelector.mockImplementation(
    async (flags: Map<string, string | boolean>) => {
      const value = flags.get('worktree')
      return typeof value === 'string' && value.length > 0 ? value : undefined
    }
  )
  vi.spyOn(console, 'log').mockImplementation(() => undefined)
})

afterEach(() => {
  vi.restoreAllMocks()
  for (const key of HOST_ENV) {
    const value = savedEnv.get(key)
    if (value === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  }
})

function clientFor(
  worktrees: ListedWorktree[],
  truncated = false,
  isRemote = false
): {
  call: ReturnType<typeof vi.fn>
  client: RuntimeClient
} {
  const call = vi.fn(async (method: string, params: Record<string, unknown>) => {
    if (method === 'worktree.show') {
      const selector = String(params.worktree)
      const id = selector.startsWith('id:') ? selector.slice('id:'.length) : selector
      const found = worktrees.find((worktree) => worktree.id === id)
      if (!found) {
        throw new Error(`missing worktree ${selector}`)
      }
      return { result: { worktree: found } }
    }
    if (method === 'worktree.list') {
      return { result: { worktrees, totalCount: worktrees.length, truncated } }
    }
    if (method === 'files.open' || method === 'files.openDiff') {
      return {
        result: {
          opened: true,
          relativePath: params.relativePath,
          kind: 'text',
          worktree: params.worktree
        }
      }
    }
    throw new Error(`unexpected ${method}`)
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: file open only reads client.call and client.isRemote.
  return { call, client: { call, isRemote } as unknown as RuntimeClient }
}

async function run(
  command: 'file open' | 'file diff',
  argv: string[],
  worktrees: ListedWorktree[],
  truncated = false
): Promise<ReturnType<typeof vi.fn>> {
  const paths = COMMAND_SPECS.flatMap((spec) => specPaths(spec))
  const parsed = normalizeCommandPositionals(COMMAND_SPECS, parseArgs(argv, paths, COMMAND_SPECS))
  const { call, client } = clientFor(worktrees, truncated)
  const ctx: HandlerContext = {
    flags: parsed.flags,
    client,
    cwd: '/repos/current',
    json: true,
    rawArgs: argv
  }
  await FILE_HANDLERS[command](ctx)
  return call
}

const catalog: ListedWorktree[] = [
  { id: 'repoA::/repos/current', path: '/repos/current' },
  { id: 'repoA::/repos/feature', path: '/repos/feature' },
  { id: 'repoA::/repos/feature/nested', path: '/repos/feature/nested' },
  { id: 'repoB::/repos/feature', path: '/repos/feature', hostId: 'ssh:box' }
]

describe('file open absolute paths outside the selected worktree', () => {
  it('opens an absolute path in the other registered worktree', async () => {
    const call = await run(
      'file open',
      ['file', 'open', '/repos/feature/README.md', '--json'],
      catalog
    )
    expect(call.mock.calls.filter((entry) => entry[0] === 'files.open')).toEqual([
      [
        'files.open',
        {
          worktree: 'id:repoA::/repos/feature',
          relativePath: 'README.md',
          navigation: 'caller'
        }
      ]
    ])
    expect(call.mock.calls.find((entry) => entry[0] === 'worktree.list')?.[1]).toEqual({
      limit: 10000
    })
  })

  it('opens a nested worktree instead of its parent', async () => {
    const call = await run(
      'file open',
      ['file', 'open', '/repos/feature/nested/README.md', '--json'],
      catalog
    )
    expect(call.mock.calls.filter((entry) => entry[0] === 'files.open')).toEqual([
      [
        'files.open',
        {
          worktree: 'id:repoA::/repos/feature/nested',
          relativePath: 'README.md',
          navigation: 'caller'
        }
      ]
    ])
  })

  it('rejects a path outside every registered worktree before files.open', async () => {
    const paths = COMMAND_SPECS.flatMap((spec) => specPaths(spec))
    const argv = ['file', 'open', '/home/AGENTS.md', '--json']
    const parsed = normalizeCommandPositionals(COMMAND_SPECS, parseArgs(argv, paths, COMMAND_SPECS))
    const { call, client } = clientFor(catalog)
    const ctx: HandlerContext = {
      flags: parsed.flags,
      client,
      cwd: '/repos/current',
      json: true,
      rawArgs: argv
    }
    await expect(FILE_HANDLERS['file open'](ctx)).rejects.toMatchObject({
      code: 'invalid_argument',
      message: 'That absolute path is outside every registered worktree.',
      data: {
        nextSteps: [
          'Pass --worktree path:<workspace> when the file is in a folder workspace or on another host (`orca worktree ps --json`).',
          'Registering a folder with `orca repo add --path <dir> --kind folder` does not select it. Retry with --worktree path:<dir>.'
        ]
      }
    })
    expect(call.mock.calls.map((entry) => entry[0])).toEqual(['worktree.show', 'worktree.list'])
  })

  it('does not retarget when --worktree was explicit', async () => {
    const paths = COMMAND_SPECS.flatMap((spec) => specPaths(spec))
    const argv = ['file', 'open', '/repos/feature/README.md', '--worktree', CURRENT, '--json']
    const parsed = normalizeCommandPositionals(COMMAND_SPECS, parseArgs(argv, paths, COMMAND_SPECS))
    const { call, client } = clientFor(catalog)
    const ctx: HandlerContext = {
      flags: parsed.flags,
      client,
      cwd: '/repos/current',
      json: true,
      rawArgs: argv
    }
    await expect(FILE_HANDLERS['file open'](ctx)).rejects.toMatchObject({
      code: 'invalid_argument',
      message: 'That absolute path is outside the selected worktree.'
    })
    expect(call.mock.calls.map((entry) => entry[0])).toEqual(['worktree.show'])
  })

  it('does not tell a remote client to omit --worktree', async () => {
    const paths = COMMAND_SPECS.flatMap((spec) => specPaths(spec))
    const argv = ['file', 'open', '/repos/feature/README.md', '--worktree', CURRENT, '--json']
    const parsed = normalizeCommandPositionals(COMMAND_SPECS, parseArgs(argv, paths, COMMAND_SPECS))
    const { client } = clientFor(catalog, false, true)
    const ctx: HandlerContext = {
      flags: parsed.flags,
      client,
      cwd: '/repos/current',
      json: true,
      rawArgs: argv
    }
    await expect(FILE_HANDLERS['file open'](ctx)).rejects.toMatchObject({
      code: 'invalid_argument',
      message: 'That absolute path is outside the selected worktree.',
      data: {
        nextSteps: [
          'Pass --worktree path:<workspace> for the registered workspace that contains the file (`orca worktree ps --json`).'
        ]
      }
    })
  })

  it('asks for one selector when two local worktrees contain the path', async () => {
    const tied: ListedWorktree[] = [
      { id: 'repoA::/repos/current', path: '/repos/current' },
      { id: 'repoA::/repos/same', path: '/repos/same' },
      { id: 'repoB::/repos/same', path: '/repos/same' }
    ]
    const paths = COMMAND_SPECS.flatMap((spec) => specPaths(spec))
    const argv = ['file', 'open', '/repos/same/README.md', '--json']
    const parsed = normalizeCommandPositionals(COMMAND_SPECS, parseArgs(argv, paths, COMMAND_SPECS))
    const { call, client } = clientFor(tied)
    const ctx: HandlerContext = {
      flags: parsed.flags,
      client,
      cwd: '/repos/current',
      json: true,
      rawArgs: argv
    }
    await expect(FILE_HANDLERS['file open'](ctx)).rejects.toMatchObject({
      code: 'selector_ambiguous',
      message:
        'More than one registered worktree contains that absolute path. Pass --worktree with one selector.',
      data: {
        validSelectorForms: ['id:repoA::/repos/same', 'id:repoB::/repos/same']
      }
    })
    expect(call.mock.calls.map((entry) => entry[0])).toEqual(['worktree.show', 'worktree.list'])
  })

  it('does not open an ssh worktree for a local caller', async () => {
    const remoteOnly: ListedWorktree[] = [
      { id: 'repoA::/repos/current', path: '/repos/current' },
      { id: 'repoB::/repos/feature', path: '/repos/feature', hostId: 'ssh:box' }
    ]
    const paths = COMMAND_SPECS.flatMap((spec) => specPaths(spec))
    const argv = ['file', 'open', '/repos/feature/README.md', '--json']
    const parsed = normalizeCommandPositionals(COMMAND_SPECS, parseArgs(argv, paths, COMMAND_SPECS))
    const { call, client } = clientFor(remoteOnly)
    const ctx: HandlerContext = {
      flags: parsed.flags,
      client,
      cwd: '/repos/current',
      json: true,
      rawArgs: argv
    }
    await expect(FILE_HANDLERS['file open'](ctx)).rejects.toMatchObject({
      code: 'invalid_argument',
      message: 'That absolute path is outside every registered worktree.'
    })
    expect(call.mock.calls.some((entry) => entry[0] === 'files.open')).toBe(false)
  })

  it('does not guess when the worktree list is truncated', async () => {
    const paths = COMMAND_SPECS.flatMap((spec) => specPaths(spec))
    const argv = ['file', 'open', '/repos/feature/README.md', '--json']
    const parsed = normalizeCommandPositionals(COMMAND_SPECS, parseArgs(argv, paths, COMMAND_SPECS))
    const { call, client } = clientFor(catalog, true)
    const ctx: HandlerContext = {
      flags: parsed.flags,
      client,
      cwd: '/repos/current',
      json: true,
      rawArgs: argv
    }
    await expect(FILE_HANDLERS['file open'](ctx)).rejects.toMatchObject({
      code: 'invalid_argument',
      message:
        'The worktree list was truncated, so this absolute path was not matched to another worktree.'
    })
    expect(call.mock.calls.map((entry) => entry[0])).toEqual(['worktree.show', 'worktree.list'])
  })

  it('opens a diff in the other registered worktree', async () => {
    const call = await run(
      'file diff',
      ['file', 'diff', '/repos/feature/README.md', '--json'],
      catalog
    )
    expect(call.mock.calls.filter((entry) => entry[0] === 'files.openDiff')).toEqual([
      [
        'files.openDiff',
        {
          worktree: 'id:repoA::/repos/feature',
          relativePath: 'README.md',
          staged: false,
          navigation: 'caller'
        }
      ]
    ])
  })
})
