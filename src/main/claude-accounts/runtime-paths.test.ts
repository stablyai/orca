import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const testState = {
  fakeHomeDir: '',
  previousConfigDir: undefined as string | undefined
}

vi.mock('node:os', async () => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports -- vi.importActual requires inline import()
  const actual = await vi.importActual<typeof import('node:os')>('node:os')
  return {
    ...actual,
    homedir: () => testState.fakeHomeDir
  }
})

const { ClaudeRuntimePathResolver } = await import('./runtime-paths')

beforeEach(() => {
  testState.fakeHomeDir = mkdtempSync(join(tmpdir(), 'orca-claude-runtime-paths-'))
  testState.previousConfigDir = process.env.CLAUDE_CONFIG_DIR
  delete process.env.CLAUDE_CONFIG_DIR
})

afterEach(() => {
  rmSync(testState.fakeHomeDir, { recursive: true, force: true })
  if (testState.previousConfigDir === undefined) {
    delete process.env.CLAUDE_CONFIG_DIR
  } else {
    process.env.CLAUDE_CONFIG_DIR = testState.previousConfigDir
  }
  testState.fakeHomeDir = ''
})

describe('ClaudeRuntimePathResolver', () => {
  it('leaves the default config directory alone while resolving paths', () => {
    const paths = new ClaudeRuntimePathResolver().getRuntimePaths()

    expect(paths.configDir).toBe(join(testState.fakeHomeDir, '.claude'))
    // Why: background rate-limit refreshes resolve these paths even when Claude
    // is disabled, so resolving must never materialize the directory (#12181).
    expect(existsSync(paths.configDir)).toBe(false)
  })

  it('leaves an inherited CLAUDE_CONFIG_DIR alone while resolving paths', () => {
    const inherited = join(testState.fakeHomeDir, 'inherited-claude')
    process.env.CLAUDE_CONFIG_DIR = inherited

    const paths = new ClaudeRuntimePathResolver().getRuntimePaths()

    expect(paths.configDir).toBe(inherited)
    expect(existsSync(inherited)).toBe(false)
    expect(paths.envPatch).toEqual({ CLAUDE_CONFIG_DIR: inherited })
  })

  it('resolves credentials next to the config directory', () => {
    const paths = new ClaudeRuntimePathResolver().getRuntimePaths()

    expect(paths.credentialsPath).toBe(join(testState.fakeHomeDir, '.claude', '.credentials.json'))
  })

  it('falls back to the home config file when no colocated config exists', () => {
    const paths = new ClaudeRuntimePathResolver().getRuntimePaths()

    expect(paths.configPath).toBe(join(testState.fakeHomeDir, '.claude.json'))
    expect(paths.envPatch).toEqual({})
  })

  it('prefers a colocated config file once it exists', () => {
    const configDir = join(testState.fakeHomeDir, '.claude')
    mkdirSync(configDir, { recursive: true })
    writeFileSync(join(configDir, '.claude.json'), '{}')

    const paths = new ClaudeRuntimePathResolver().getRuntimePaths()

    expect(paths.configPath).toBe(join(configDir, '.claude.json'))
  })

  it('keeps the inherited config file colocated even before it exists', () => {
    const inherited = join(testState.fakeHomeDir, 'inherited-claude')
    process.env.CLAUDE_CONFIG_DIR = inherited

    const paths = new ClaudeRuntimePathResolver().getRuntimePaths()

    expect(paths.configPath).toBe(join(inherited, '.claude.json'))
  })
})
