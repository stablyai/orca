import type * as NodeFsModule from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import type * as NodeFsPromisesModule from 'node:fs/promises'
import { tmpdir } from 'node:os'
import type * as NodeOsModule from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  home: '',
  syncCalls: [] as { name: string; target: string }[],
  blockAsyncReads: false
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

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFsPromisesModule>()
  return {
    ...actual,
    default: actual,
    readFile: (...args: Parameters<typeof actual.readFile>) =>
      state.blockAsyncReads && String(args[0]).startsWith(state.home)
        ? new Promise<never>(() => {})
        : actual.readFile(...args)
  }
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
    state.blockAsyncReads = false
  })

  afterEach(async () => {
    state.blockAsyncReads = false
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

  it('keeps the event loop responsive while a HOME read is stalled', async () => {
    state.blockAsyncReads = true
    const refresh = MANAGED_AGENT_HOOK_SCRIPT_REFRESHERS[0][1]()
    let settled = false
    void refresh.then(() => {
      settled = true
    })

    await new Promise<void>((resolve) => setTimeout(resolve, 5))

    expect(settled).toBe(false)
  })
})
