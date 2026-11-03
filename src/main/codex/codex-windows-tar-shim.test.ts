import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ensureCodexWindowsTarShimDirectory,
  frontCodexWindowsTarShimPath,
  withCodexWindowsTarShimResolvers
} from './codex-windows-tar-shim'

// Windows ships bsdtar as System32\tar.exe; Git for Windows' GNU tar cannot read native paths.
const GIT_USR_BIN = 'C:\\Program Files\\Git\\usr\\bin'
const SYSTEM32 = 'C:\\Windows\\System32'
const SHIM_CONTENT = '@"%SystemRoot%\\System32\\tar.exe" %*\r\n'

const created: string[] = []

afterEach(async () => {
  await Promise.all(
    created.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  )
})

describe('ensureCodexWindowsTarShimDirectory', () => {
  it("writes a tar.cmd that forwards to Windows' own tar", async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), 'orca-codex-tar-'))
    created.push(dataDirectory)
    const directory = await ensureCodexWindowsTarShimDirectory(dataDirectory, 'win32')
    expect(directory).toBe(join(dataDirectory, 'codex-tar-shim'))
    expect(await readFile(join(directory!, 'tar.cmd'), 'utf8')).toBe(SHIM_CONTENT)
  })

  it('rewrites a tar.cmd altered away from the forwarder', async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), 'orca-codex-tar-'))
    created.push(dataDirectory)
    const directory = join(dataDirectory, 'codex-tar-shim')
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'tar.cmd'), '@echo off\r\n')
    expect(await ensureCodexWindowsTarShimDirectory(dataDirectory, 'win32')).toBe(directory)
    expect(await readFile(join(directory, 'tar.cmd'), 'utf8')).toBe(SHIM_CONTENT)
  })

  it('leaves PATH untouched off Windows', async () => {
    expect(await ensureCodexWindowsTarShimDirectory('Z:\\missing', 'linux')).toBe(null)
  })

  it('answers null, instead of throwing, when the directory cannot be created', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      // A file where the shim directory belongs makes the mkdir fail.
      const blocked = await mkdtemp(join(tmpdir(), 'orca-codex-blocked-'))
      created.push(blocked)
      await writeFile(join(blocked, 'codex-tar-shim'), '')
      expect(await ensureCodexWindowsTarShimDirectory(blocked, 'win32')).toBe(null)
      expect(warn).toHaveBeenCalledOnce()
    } finally {
      warn.mockRestore()
    }
  })
})

describe('frontCodexWindowsTarShimPath', () => {
  const env = (pathKey: string, value: string): Record<string, string> => ({ [pathKey]: value })

  it("puts the shim ahead of Git for Windows' tar and the system PATH", () => {
    const fronted = frontCodexWindowsTarShimPath(
      env('PATH', `${GIT_USR_BIN};${SYSTEM32}`),
      'D:\\userData\\codex-tar-shim',
      'win32'
    )
    expect(fronted).toEqual({
      PATH: `D:\\userData\\codex-tar-shim;${GIT_USR_BIN};${SYSTEM32}`
    })
  })

  it('keeps the existing Path spelling and drops an earlier duplicate of the shim', () => {
    const shim = 'D:\\userData\\codex-tar-shim'
    const fronted = frontCodexWindowsTarShimPath(
      env('Path', `${GIT_USR_BIN};${shim.toLowerCase()}\\`),
      shim,
      'win32'
    )
    expect(fronted).toEqual({ Path: `${shim};${GIT_USR_BIN}` })
  })

  it('changes nothing without a shim directory, without PATH, or off Windows', () => {
    const unchanged = env('PATH', GIT_USR_BIN)
    expect(frontCodexWindowsTarShimPath(unchanged, null, 'win32')).toBe(unchanged)
    expect(frontCodexWindowsTarShimPath({}, 'D:\\shim', 'win32')).toEqual({})
    expect(frontCodexWindowsTarShimPath(unchanged, 'D:\\shim', 'linux')).toBe(unchanged)
  })
})

describe('withCodexWindowsTarShimResolvers', () => {
  const resolversOver = (base: Record<string, string>) => ({
    resolveBaseEnvironment: async () => ({ ...base }),
    resolveAgentEnvironment: async (agent: string) => ({ ...base, AGENT: agent }),
    refreshAfterMissingProgram: async () => {},
    bindCatalogSources: () => () => {}
  })

  it('fronts the shim for codex only', async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), 'orca-codex-tar-'))
    created.push(dataDirectory)
    const shim = join(dataDirectory, 'codex-tar-shim')
    const resolvers = withCodexWindowsTarShimResolvers(
      resolversOver({ PATH: `${GIT_USR_BIN};${SYSTEM32}` }),
      dataDirectory,
      'win32'
    )
    expect(await resolvers.resolveAgentEnvironment('codex')).toEqual({
      PATH: `${shim};${GIT_USR_BIN};${SYSTEM32}`,
      AGENT: 'codex'
    })
    expect(await resolvers.resolveAgentEnvironment('claude')).toEqual({
      PATH: `${GIT_USR_BIN};${SYSTEM32}`,
      AGENT: 'claude'
    })
    expect(await readFile(join(shim, 'tar.cmd'), 'utf8')).toBe(SHIM_CONTENT)
  })

  it('returns the resolvers unchanged off Windows', () => {
    const resolvers = resolversOver({ PATH: '/usr/bin' })
    expect(withCodexWindowsTarShimResolvers(resolvers, '/data', 'linux')).toBe(resolvers)
  })
})
