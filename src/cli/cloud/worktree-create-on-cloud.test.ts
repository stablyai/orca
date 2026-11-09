import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nodeCloudCredentialFs } from './cloud-credentials'
import {
  createWorktreeOnCloud,
  readCloudOnTarget,
  resolveCloudRepo,
  type CloudOnDeps
} from './worktree-create-on-cloud'

let home: string
let logs: string[]
let errs: string[]

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'orca-cloud-on-'))
  logs = []
  errs = []
  vi.spyOn(console, 'log').mockImplementation((line: unknown) => void logs.push(String(line)))
  vi.spyOn(console, 'error').mockImplementation((line: unknown) => void errs.push(String(line)))
})

afterEach(() => {
  vi.restoreAllMocks()
  rmSync(home, { recursive: true, force: true })
})

function setup(origins: Record<string, string> = {}) {
  const bodies: unknown[] = []
  const fetchImpl = vi.fn(async (input: string, init: RequestInit) => {
    const path = new URL(input).pathname
    if (path === '/v1/projects') {
      return Response.json({ projects: [{ id: 'prj_9', name: 'web' }] })
    }
    bodies.push(JSON.parse(String(init.body)))
    return Response.json(
      {
        workspace: {
          id: 'sbx_n1',
          name: 'task',
          status: 'running',
          origin: 'vm',
          machineSize: 'standard'
        }
      },
      { status: 201 }
    )
  })
  const deps: CloudOnDeps = {
    env: { ORCA_CLOUD_TOKEN: 'orca_ws_x', ORCA_CLOUD_API_URL: 'https://cloud.test' },
    fetch: fetchImpl,
    fs: nodeCloudCredentialFs,
    home,
    now: () => 0,
    sleep: async () => {},
    readStdin: async () => null,
    originUrl: (dir) => origins[dir] ?? null
  }
  return { bodies, fetchImpl, deps }
}

const flags = (entries: Record<string, string | boolean>) => new Map(Object.entries(entries))

describe('readCloudOnTarget', () => {
  it('claims cloud and cloud:<project> only', () => {
    expect(readCloudOnTarget(flags({ on: 'cloud' }))).toEqual({ project: null })
    expect(readCloudOnTarget(flags({ on: 'cloud:web' }))).toEqual({ project: 'web' })
    expect(readCloudOnTarget(flags({ on: 'recipe:dev' }))).toBeNull()
    expect(readCloudOnTarget(flags({ on: 'local' }))).toBeNull()
    expect(readCloudOnTarget(flags({}))).toBeNull()
    expect(() => readCloudOnTarget(flags({ on: 'cloud:' }))).toThrow('project id or name')
  })
})

describe('resolveCloudRepo', () => {
  it('uses a URL as given, a checkout path via its origin, else the cwd checkout', () => {
    const origins = { [home]: 'git@github.com:acme/app.git' }
    expect(resolveCloudRepo(flags({ repo: 'https://github.com/a/b' }), '/x', () => null)).toEqual({
      url: 'https://github.com/a/b'
    })
    expect(resolveCloudRepo(flags({ repo: home }), '/x', (d) => origins[d] ?? null)).toEqual({
      url: 'https://github.com/acme/app.git'
    })
    expect(resolveCloudRepo(flags({}), home, (d) => origins[d] ?? null)).toEqual({
      url: 'https://github.com/acme/app.git'
    })
    expect(resolveCloudRepo(flags({}), '/nowhere', () => null)).toBeNull()
    expect(() => resolveCloudRepo(flags({ repo: 'id:abc' }), home, () => null)).toThrow(
      'git URL or a local checkout'
    )
  })
})

describe('worktree create --on cloud', () => {
  it('creates a cloud workspace from the cwd checkout with the startup agent as first message', async () => {
    const { bodies, deps } = setup({ [home]: 'https://github.com/acme/app' })
    await createWorktreeOnCloud(
      {
        flags: flags({
          on: 'cloud',
          name: 'task',
          agent: 'claude',
          prompt: 'fix it',
          'base-branch': 'dev',
          json: true
        }),
        cwd: home,
        json: true
      },
      () => deps
    )
    expect(bodies[0]).toEqual({
      name: 'task',
      repo: { url: 'https://github.com/acme/app', ref: 'dev' },
      message: { text: 'fix it', agent: 'claude' }
    })
    expect(JSON.parse(logs.at(-1)!)).toMatchObject({
      ok: true,
      schemaVersion: 1,
      result: {
        workspace: { id: 'sbx_n1' },
        host: {
          id: 'sbx_n1',
          origin: { target: 'cloud' },
          lifecycle: 'per-workspace',
          state: 'running'
        }
      }
    })
    // --json defaults progress to none so stderr stays quiet for scripts.
    expect(errs).toEqual([])
  })

  it('cloud:<project> resolves the project and skips repo inference', async () => {
    const { bodies, deps } = setup({ [home]: 'https://github.com/acme/app' })
    await createWorktreeOnCloud(
      { flags: flags({ on: 'cloud:web', name: 't' }), cwd: home, json: false },
      () => deps
    )
    expect(bodies[0]).toEqual({ name: 't', projectId: 'prj_9' })
    expect(errs[0]).toContain('Creating an Orca Cloud workspace')
  })

  it('refuses flags and agents a cloud workspace cannot honour, before any request', async () => {
    const { fetchImpl, deps } = setup()
    const run = (f: Record<string, string | boolean>) =>
      createWorktreeOnCloud(
        { flags: flags({ on: 'cloud', name: 't', ...f }), cwd: home, json: true },
        () => deps
      )
    await expect(run({ 'parent-worktree': 'active' })).rejects.toThrow(
      "--parent-worktree doesn't apply to --on cloud"
    )
    await expect(run({ agent: 'gemini', prompt: 'x' })).rejects.toThrow(
      '--agent gemini is not available'
    )
    await expect(run({ prompt: 'x' })).rejects.toThrow('--prompt requires --agent')
    await expect(run({ size: 'xl' })).rejects.toThrow('--size')
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
