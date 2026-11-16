import { homedir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AiVaultScanOptions } from '../session-scanner-types'

/** Exercise root consumers: module-time constants can bypass an otherwise correct override validator (#13082). */

const NO_OPTIONS: AiVaultScanOptions = {}
const NO_WSL: readonly string[] = []

afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
})

describe('Pi session roots', () => {
  it('reads Pi sessions from PI_CODING_AGENT_SESSION_DIR before the agent home', async () => {
    vi.resetModules()
    vi.stubEnv('PI_CODING_AGENT_DIR', '/opt/.pi/agent')
    vi.stubEnv('PI_CODING_AGENT_SESSION_DIR', '/mnt/transcripts')
    const { AI_VAULT_AGENT_SOURCES } = await import('./session-scanner-agent-sources.js')
    expect(AI_VAULT_AGENT_SOURCES.pi?.rootDirs(NO_OPTIONS, NO_WSL)).toEqual([
      '/mnt/transcripts',
      '/opt/.pi/agent/sessions'
    ])
  })

  it('keeps the agent home indexed when only the session dir is configured', async () => {
    vi.resetModules()
    vi.stubEnv('PI_CODING_AGENT_DIR', '')
    vi.stubEnv('PI_CODING_AGENT_SESSION_DIR', '/mnt/transcripts')
    const { AI_VAULT_AGENT_SOURCES } = await import('./session-scanner-agent-sources.js')
    expect(AI_VAULT_AGENT_SOURCES.pi?.rootDirs(NO_OPTIONS, NO_WSL)).toEqual([
      '/mnt/transcripts',
      join(homedir(), '.pi', 'agent', 'sessions')
    ])
  })

  it('treats a relative session dir as unusable and falls back to the agent home', async () => {
    vi.resetModules()
    vi.stubEnv('PI_CODING_AGENT_DIR', '')
    vi.stubEnv('PI_CODING_AGENT_SESSION_DIR', 'relative/transcripts')
    const { AI_VAULT_AGENT_SOURCES } = await import('./session-scanner-agent-sources.js')
    expect(AI_VAULT_AGENT_SOURCES.pi?.rootDirs(NO_OPTIONS, NO_WSL)).toEqual([
      join(homedir(), '.pi', 'agent', 'sessions')
    ])
  })
})
