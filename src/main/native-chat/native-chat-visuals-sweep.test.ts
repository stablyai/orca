import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionExecutionLocation } from '../../shared/agent-session-record'
import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import type { StructuredAgentSessionLogger } from './agent-session-wire/structured-agent-session-logger'
import { nativeChatVisualsFolderFor, nativeChatVisualsRootFor } from './native-chat-visuals-folder'
import {
  scheduleNativeChatVisualsSweep,
  sweepNativeChatVisualsFolders,
  type NativeChatVisualsSweepDeps,
  type NativeChatVisualsWorkspaceVerdict
} from './native-chat-visuals-sweep'

const scratch: string[] = []
afterEach(() => {
  vi.useRealTimers()
  for (const dir of scratch.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function stateDirectory(): string {
  const dir = mkdtempSync(join(tmpdir(), 'orca-visuals-sweep-'))
  scratch.push(dir)
  return dir
}

function visualsFor(state: string, sessionId: string): string {
  const folder = nativeChatVisualsFolderFor(state, sessionId)
  mkdirSync(folder, { recursive: true })
  writeFileSync(join(folder, 'chart.html'), '<p>chart</p>')
  return folder
}

const location = (workspaceId: string): AgentSessionExecutionLocation => ({
  executionHostId: LOCAL_EXECUTION_HOST_ID,
  wslDistro: null,
  workspaceId,
  workspaceKind: 'git-worktree'
})

function deps(
  state: string,
  held: readonly string[] | null,
  verdicts: Record<string, NativeChatVisualsWorkspaceVerdict> = {}
): NativeChatVisualsSweepDeps & {
  logger: { warn: ReturnType<typeof vi.fn<StructuredAgentSessionLogger['warn']>> }
} {
  return {
    stateDirectory: state,
    listHeldSessionIds: () => held,
    locationOf: (sessionId) => (held?.includes(sessionId) ? location(`ws-${sessionId}`) : null),
    workspaceVerdicts: () => async (where) => verdicts[where.workspaceId] ?? 'present',
    logger: { warn: vi.fn<StructuredAgentSessionLogger['warn']>(), error: vi.fn() }
  }
}

describe('the visuals folder sweep', () => {
  it('removes a folder no chat record maps to and keeps every held chat', async () => {
    const state = stateDirectory()
    const live = visualsFor(state, 'chat-live')
    const unreadable = visualsFor(state, 'chat-unreadable-row')
    const orphan = visualsFor(state, 'chat-deleted')
    const result = await sweepNativeChatVisualsFolders(
      deps(state, ['chat-live', 'chat-unreadable-row'])
    )
    expect(result).toEqual({ removed: 1, failed: 0 })
    expect(existsSync(live)).toBe(true)
    expect(existsSync(unreadable)).toBe(true)
    expect(existsSync(orphan)).toBe(false)
  })

  it('removes a chat folder only when its local workspace is proven removed', async () => {
    const state = stateDirectory()
    const removed = visualsFor(state, 'chat-a')
    const unverifiable = visualsFor(state, 'chat-b')
    const present = visualsFor(state, 'chat-c')
    await sweepNativeChatVisualsFolders(
      deps(state, ['chat-a', 'chat-b', 'chat-c'], {
        'ws-chat-a': 'removed',
        'ws-chat-b': 'unverifiable'
      })
    )
    expect(existsSync(removed)).toBe(false)
    expect(existsSync(unverifiable)).toBe(true)
    expect(existsSync(present)).toBe(true)
  })

  it('keeps a held chat whose workspace verdict throws', async () => {
    const state = stateDirectory()
    const folder = visualsFor(state, 'chat-a')
    await sweepNativeChatVisualsFolders({
      ...deps(state, ['chat-a']),
      workspaceVerdicts: () => async () => {
        throw new Error('catalog unavailable')
      }
    })
    expect(existsSync(folder)).toBe(true)
  })

  it('removes nothing when the held chats cannot be read', async () => {
    const state = stateDirectory()
    const folder = visualsFor(state, 'chat-a')
    await expect(sweepNativeChatVisualsFolders(deps(state, null))).resolves.toEqual({
      removed: 0,
      failed: 0
    })
    expect(existsSync(folder)).toBe(true)
  })

  it('never touches entries it did not mint, symlinks included', async () => {
    const state = stateDirectory()
    const root = nativeChatVisualsRootFor(state)
    mkdirSync(join(root, 'notes'), { recursive: true })
    writeFileSync(join(root, 'f'.repeat(32)), 'a file, not a folder')
    const target = mkdtempSync(join(tmpdir(), 'orca-visuals-target-'))
    scratch.push(target)
    writeFileSync(join(target, 'keep.txt'), 'keep')
    symlinkSync(target, join(root, 'e'.repeat(32)))
    await sweepNativeChatVisualsFolders(deps(state, []))
    expect(existsSync(join(root, 'notes'))).toBe(true)
    expect(existsSync(join(root, 'f'.repeat(32)))).toBe(true)
    expect(existsSync(join(root, 'e'.repeat(32)))).toBe(true)
    expect(existsSync(join(target, 'keep.txt'))).toBe(true)
  })

  it('reports a removal that fails and carries on', async () => {
    const state = stateDirectory()
    visualsFor(state, 'chat-x')
    visualsFor(state, 'chat-y')
    const sweep = deps(state, [])
    const result = await sweepNativeChatVisualsFolders({
      ...sweep,
      remove: vi
        .fn()
        .mockRejectedValueOnce(Object.assign(new Error('busy'), { code: 'EBUSY' }))
        .mockResolvedValueOnce(undefined)
    })
    expect(result).toEqual({ removed: 1, failed: 1 })
    expect(sweep.logger.warn).toHaveBeenCalledWith(
      'native-chat visuals folder could not be removed',
      expect.objectContaining({ scope: 'nativeChatVisuals.sweep', reason: 'no-record' })
    )
  })

  it('does nothing on a host with no visuals yet', async () => {
    await expect(
      sweepNativeChatVisualsFolders(deps(stateDirectory(), ['chat-a']))
    ).resolves.toEqual({ removed: 0, failed: 0 })
  })

  it('runs after startup and again later, and stops for good', async () => {
    const state = stateDirectory()
    const orphan = visualsFor(state, 'chat-z')
    vi.useFakeTimers()
    const listHeldSessionIds = vi.fn((): string[] => [])
    const stop = scheduleNativeChatVisualsSweep({ ...deps(state, []), listHeldSessionIds })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(listHeldSessionIds).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(60_000)
    await vi.waitFor(() => expect(existsSync(orphan)).toBe(false))
    expect(listHeldSessionIds).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(6 * 60 * 60_000)
    await vi.waitFor(() => expect(listHeldSessionIds).toHaveBeenCalledTimes(2))
    stop()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('touches nothing under a visuals root that is a symlink', async () => {
    const state = stateDirectory()
    const elsewhere = mkdtempSync(join(tmpdir(), 'orca-visuals-elsewhere-'))
    scratch.push(elsewhere)
    mkdirSync(join(elsewhere, 'a'.repeat(32)))
    symlinkSync(elsewhere, nativeChatVisualsRootFor(state))
    await sweepNativeChatVisualsFolders(deps(state, []))
    expect(existsSync(join(elsewhere, 'a'.repeat(32)))).toBe(true)
  })

  it('takes one verdict snapshot per run', async () => {
    const state = stateDirectory()
    visualsFor(state, 'chat-a')
    visualsFor(state, 'chat-b')
    const workspaceVerdicts = vi.fn(() => async () => 'present' as const)
    await sweepNativeChatVisualsFolders({ ...deps(state, ['chat-a', 'chat-b']), workspaceVerdicts })
    expect(workspaceVerdicts).toHaveBeenCalledOnce()
  })
})
