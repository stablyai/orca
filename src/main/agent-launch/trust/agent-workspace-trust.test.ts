import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ClaudeFolderTrustFile from '../../claude/claude-folder-trust-file'

const CODEX_CONFIG_FILES = ['/orca/codex-home/config.toml', '/home/u/.codex/config.toml']

const mocks = vi.hoisted(() => ({
  codex: vi.fn<(path: string, configFiles: readonly string[]) => Promise<void>>(async () => {}),
  cursor: vi.fn<(path: string, home: string) => void>(),
  copilot: vi.fn<(path: string, home: string) => void>(),
  antigravity: vi.fn<(path: string, home: string) => void>(),
  qoder: vi.fn<(path: string, home: string) => void>(),
  kimi: vi.fn<(path: string, kimiHome: string) => void>(),
  codexConfigFiles: vi.fn<(agentHome: string) => string[]>(() => CODEX_CONFIG_FILES),
  claudeGrant: vi.fn<typeof ClaudeFolderTrustFile.grantClaudeWorkspaceTrust>()
}))

vi.mock('./agent-trust-presets', () => ({
  markCodexProjectTrusted: mocks.codex,
  markCursorWorkspaceTrusted: mocks.cursor,
  markCopilotFolderTrusted: mocks.copilot,
  markAntigravityWorkspaceTrusted: mocks.antigravity,
  markKimiWorkspaceTrusted: mocks.kimi
}))
vi.mock('../../codex/codex-home-paths', () => ({
  getLocalCodexTrustConfigFiles: mocks.codexConfigFiles
}))
vi.mock('../../qoder/workspace-trust', () => ({ markQoderWorkspaceTrusted: mocks.qoder }))
vi.mock('../../claude/claude-folder-trust-file', async (importOriginal) => {
  const actual = await importOriginal<typeof ClaudeFolderTrustFile>()
  mocks.claudeGrant.mockImplementation(actual.grantClaudeWorkspaceTrust)
  return { ...actual, grantClaudeWorkspaceTrust: mocks.claudeGrant }
})

import { applyAgentWorkspaceTrust, type AgentTrustLaunchContext } from './agent-workspace-trust'
import {
  AGENT_TRUST_WRITE_DEADLINE_MS,
  SHORT_AGENT_TRUST_WRITE_DEADLINE_MS
} from './agent-trust-write-deadline'

const WORKSPACE = '/workspace/app'
const local: AgentTrustLaunchContext = {
  env: {},
  claudeAuth: null,
  wslDistro: null,
  connectionId: null
}

function pending(): { promise: Promise<void>; release: () => void } {
  let release!: () => void
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release }
}

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('applyAgentWorkspaceTrust on this machine', () => {
  it('gives only Codex the long deadline its shared config lane needs', async () => {
    vi.useFakeTimers()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const codexWrite = pending()
    mocks.codex.mockReturnValueOnce(codexWrite.promise)
    let codexSettled = false
    const codex = applyAgentWorkspaceTrust('codex', WORKSPACE, local).then(() => {
      codexSettled = true
    })
    await vi.advanceTimersByTimeAsync(SHORT_AGENT_TRUST_WRITE_DEADLINE_MS + 1)
    expect(codexSettled).toBe(false)
    await vi.advanceTimersByTimeAsync(AGENT_TRUST_WRITE_DEADLINE_MS)
    await codex
    expect(codexSettled).toBe(true)
    codexWrite.release()
    warn.mockRestore()
  })
})

describe('applyAgentWorkspaceTrust for Claude', () => {
  let root: string

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'orca-agent-trust-')))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('grants in the config file the final spawn env names', async () => {
    writeFileSync(join(root, '.claude.json'), '{}')
    await applyAgentWorkspaceTrust('claude', root, {
      ...local,
      env: { CLAUDE_CONFIG_DIR: root }
    })
    expect(JSON.parse(readFileSync(join(root, '.claude.json'), 'utf-8'))).toEqual({
      projects: { [root]: { hasTrustDialogAccepted: true } }
    })
  })

  it('gives a local Claude write a short budget, after which Claude asks', async () => {
    vi.useFakeTimers()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const grant = pending()
    mocks.claudeGrant.mockReturnValueOnce(grant.promise.then(() => 'granted' as const))
    let settled = false
    const claude = applyAgentWorkspaceTrust('claude', root, {
      ...local,
      env: { CLAUDE_CONFIG_DIR: root }
    }).then(() => {
      settled = true
    })
    await vi.advanceTimersByTimeAsync(SHORT_AGENT_TRUST_WRITE_DEADLINE_MS - 1)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(2)
    await claude
    expect(settled).toBe(true)
    expect(String(warn.mock.calls[0]?.[0])).toContain('did not settle')
    grant.release()
    warn.mockRestore()
  })
})
