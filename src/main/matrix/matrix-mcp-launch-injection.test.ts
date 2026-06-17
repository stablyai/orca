import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import type * as osModule from 'os'
import { join } from 'path'

// Pin homedir() to a temp dir so the managed config is written under test
// control (never the real ~/.orca). resolveClaudeAgentTeamsShimBin falls back
// to the platform command name when nothing is on PATH, which is fine here.
let tempHome: string

vi.mock('os', async (importActual) => {
  const actual = await importActual<typeof osModule>()
  return { ...actual, homedir: () => tempHome }
})

import {
  injectMatrixMcpIntoClaudeLaunch,
  shouldInjectMatrixMcp
} from './matrix-mcp-launch-injection'

beforeEach(() => {
  tempHome = mkdtempSync(join(tmpdir(), 'orca-matrix-inject-'))
})

afterEach(() => {
  rmSync(tempHome, { recursive: true, force: true })
})

describe('injectMatrixMcpIntoClaudeLaunch (matrixEnabled=true path)', () => {
  it('appends --mcp-config and sets ORCA_SESSION_ACTIVE', () => {
    const result = injectMatrixMcpIntoClaudeLaunch({
      command: 'claude',
      shell: 'posix',
      spawnEnv: { PATH: '/usr/bin' }
    })

    expect(result.command).toMatch(/^claude --mcp-config /)
    expect(result.command).toContain('.orca')
    // Awareness: the Orca-session system prompt is appended so the agent reliably
    // knows it can ask the operator rather than guessing.
    expect(result.command).toContain('--append-system-prompt')
    expect(result.command).toContain('orca_ask_operator')
    expect(result.env).toEqual({ ORCA_SESSION_ACTIVE: 'true' })
  })

  it('writes an Orca-managed MCP config under ~/.orca (not the worktree) with the matrix-mcp args', () => {
    injectMatrixMcpIntoClaudeLaunch({
      command: 'claude',
      shell: 'posix',
      spawnEnv: { PATH: '/usr/bin' }
    })

    const configPath = join(tempHome, '.orca', 'mcp', 'orca-matrix.json')
    const config = JSON.parse(readFileSync(configPath, 'utf-8'))
    expect(config.mcpServers['orca-matrix'].args).toEqual(['matrix-mcp'])
    expect(typeof config.mcpServers['orca-matrix'].command).toBe('string')
    // The MCP server inherits env, so the config carries no per-session env.
    expect(config.mcpServers['orca-matrix'].env).toBeUndefined()
  })

  it('quotes the config path so spaces in the home path survive', () => {
    const result = injectMatrixMcpIntoClaudeLaunch({
      command: 'claude',
      shell: 'posix',
      spawnEnv: {}
    })
    // posix quoting wraps the path in single quotes; the system-prompt flag now
    // follows it, so the config path is no longer at end-of-string.
    expect(result.command).toMatch(/--mcp-config '.*orca-matrix\.json'/)
  })
})

describe('shouldInjectMatrixMcp (the launch gate)', () => {
  it('gates OFF when matrixEnabled is false, so the launch is unchanged', () => {
    expect(
      shouldInjectMatrixMcp({ isClaudeLaunch: true, matrixEnabled: false, command: 'claude' })
    ).toBe(false)
  })

  it('gates OFF for non-Claude launches even when Matrix is enabled', () => {
    expect(
      shouldInjectMatrixMcp({ isClaudeLaunch: false, matrixEnabled: true, command: 'codex' })
    ).toBe(false)
  })

  it('gates OFF when there is no command string', () => {
    expect(
      shouldInjectMatrixMcp({ isClaudeLaunch: true, matrixEnabled: true, command: undefined })
    ).toBe(false)
  })

  it('gates ON only for an enabled Claude launch with a command', () => {
    expect(
      shouldInjectMatrixMcp({ isClaudeLaunch: true, matrixEnabled: true, command: 'claude' })
    ).toBe(true)
  })
})
