import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const scanned = vi.hoisted(() => ({ dirs: [] as string[], hits: {} as Record<string, string> }))
vi.mock('../ai-vault/session-scanner-discovery', () => ({
  walkSessionFiles: async (dir: string) => {
    scanned.dirs.push(dir)
    const hit = scanned.hits[dir]
    return hit ? [hit] : []
  }
}))

import { homedir } from 'node:os'
import { join } from 'node:path'
import { resolveSessionFilePath } from './session-file-resolver'

const DEFAULT_ROOT = join(homedir(), '.claude', 'projects')
const CONFIG_DIR = '/opt/claude-home'
const CONFIG_ROOT = join(CONFIG_DIR, 'projects')

let previousConfigDir: string | undefined

beforeEach(() => {
  previousConfigDir = process.env.CLAUDE_CONFIG_DIR
  scanned.dirs = []
  scanned.hits = {}
})

afterEach(() => {
  if (previousConfigDir === undefined) {
    delete process.env.CLAUDE_CONFIG_DIR
  } else {
    process.env.CLAUDE_CONFIG_DIR = previousConfigDir
  }
})

/**
 * Honouring CLAUDE_CONFIG_DIR fixed new sessions but would otherwise hide every
 * transcript written before the user adopted the variable. The Codex resolver in this
 * same file already searches managed-then-default and de-dupes; Claude does the same.
 */
describe('claude transcript roots', () => {
  it('searches the config-dir root first, then the default home', async () => {
    process.env.CLAUDE_CONFIG_DIR = CONFIG_DIR

    await resolveSessionFilePath('claude', 'session-1')

    expect(scanned.dirs).toEqual([CONFIG_ROOT, DEFAULT_ROOT])
  })

  it('still finds history written before CLAUDE_CONFIG_DIR was adopted', async () => {
    process.env.CLAUDE_CONFIG_DIR = CONFIG_DIR
    const legacy = join(DEFAULT_ROOT, '-repos-old', 'session-1.jsonl')
    scanned.hits[DEFAULT_ROOT] = legacy

    await expect(resolveSessionFilePath('claude', 'session-1')).resolves.toBe(legacy)
  })

  it('prefers the config-dir root when both hold the session', async () => {
    process.env.CLAUDE_CONFIG_DIR = CONFIG_DIR
    scanned.hits[CONFIG_ROOT] = join(CONFIG_ROOT, '-repos-new', 'session-1.jsonl')
    scanned.hits[DEFAULT_ROOT] = join(DEFAULT_ROOT, '-repos-old', 'session-1.jsonl')

    await expect(resolveSessionFilePath('claude', 'session-1')).resolves.toBe(
      scanned.hits[CONFIG_ROOT]
    )
    // The default root is never reached, so the common case pays for one scan.
    expect(scanned.dirs).toEqual([CONFIG_ROOT])
  })

  it('scans one root when the variable is unset', async () => {
    delete process.env.CLAUDE_CONFIG_DIR

    await resolveSessionFilePath('claude', 'session-1')

    expect(scanned.dirs).toEqual([DEFAULT_ROOT])
  })

  it('de-dupes when CLAUDE_CONFIG_DIR names the default home', async () => {
    process.env.CLAUDE_CONFIG_DIR = join(homedir(), '.claude')

    await resolveSessionFilePath('claude', 'session-1')

    expect(scanned.dirs).toEqual([DEFAULT_ROOT])
  })

  it('honours an explicit root override without adding fallbacks', async () => {
    process.env.CLAUDE_CONFIG_DIR = CONFIG_DIR
    // The account-home callers (structured-claude-runtime-adapter, the host handoff)
    // know the exact tree their session pinned; a fallback there could resolve a
    // different account's transcript.
    await resolveSessionFilePath('claude', 'session-1', {
      claudeProjectsDir: '/accounts/pinned/projects'
    })

    expect(scanned.dirs).toEqual(['/accounts/pinned/projects'])
  })
})
