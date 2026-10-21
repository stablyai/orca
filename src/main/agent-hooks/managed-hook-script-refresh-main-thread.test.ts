import type * as NodeFsModule from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import type * as NodeOsModule from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted((): { home: string; syncCalls: { name: string; target: string }[] } => ({
  home: '',
  syncCalls: []
}))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFsModule>()
  const wrapped: Record<string, unknown> = { ...actual }
  for (const [name, value] of Object.entries(actual)) {
    if (!name.endsWith('Sync') || typeof value !== 'function') {
      continue
    }
    const original = value as ((...args: unknown[]) => unknown) & Record<string, unknown>
    const recorder = (...args: unknown[]): unknown => {
      state.syncCalls.push({ name, target: typeof args[0] === 'string' ? args[0] : '' })
      return original(...args)
    }
    Object.assign(recorder, original)
    wrapped[name] = recorder
  }
  return { ...wrapped, default: wrapped }
})

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeOsModule>()
  return { ...actual, default: actual, homedir: () => state.home }
})

vi.mock('electron', () => ({ app: { getPath: () => '/tmp/orca-user-data' } }))

import { MANAGED_AGENT_HOOK_SCRIPT_REFRESHERS } from './managed-agent-hook-registry'

function syncCallsUnderHome(): string[] {
  return state.syncCalls
    .filter((call) => call.target.startsWith(state.home))
    .map((call) => `${call.name}(${call.target})`)
}

describe('managed hook script refresh stays off the main thread', () => {
  beforeEach(async () => {
    state.home = await mkdtemp(join(tmpdir(), 'orca-hook-refresh-main-thread-'))
    state.syncCalls = []
  })

  afterEach(async () => {
    await rm(state.home, { recursive: true, force: true })
  })

  it('uses no synchronous HOME filesystem calls for missing or stale scripts', async () => {
    const hooksDir = join(state.home, '.orca', 'agent-hooks')
    const claudeScript = join(
      hooksDir,
      process.platform === 'win32' ? 'claude-hook.cmd' : 'claude-hook.sh'
    )
    await mkdir(hooksDir, { recursive: true })
    await writeFile(claudeScript, 'stale', 'utf-8')
    state.syncCalls = []

    for (const [, refresh] of MANAGED_AGENT_HOOK_SCRIPT_REFRESHERS) {
      await refresh()
    }

    expect(syncCallsUnderHome()).toEqual([])
  })

  it('keeps the Windows Claude entry and payload refresh off the main thread', async () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    try {
      const hooksDir = join(state.home, '.orca', 'agent-hooks')
      await mkdir(hooksDir, { recursive: true })
      await writeFile(join(hooksDir, 'claude-hook.cmd'), 'stale', 'utf-8')
      state.syncCalls = []

      await MANAGED_AGENT_HOOK_SCRIPT_REFRESHERS.find(([agent]) => agent === 'claude')![1]()

      expect(syncCallsUnderHome()).toEqual([])
    } finally {
      Object.defineProperty(process, 'platform', platform)
    }
  })
})
