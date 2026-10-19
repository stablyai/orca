import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runKeyedSerializedOperation } from '../cli/keyed-promise-queue'
import type { StructuredAgentSessionLogger } from './agent-session-wire/structured-agent-session-logger'
import { nativeChatScratchFolderFor, nativeChatScratchRootFor } from './native-chat-scratch-folder'
import { migrateLegacyNativeChatVisualsFolders } from './native-chat-scratch-folder-migration'
import {
  runNativeChatScratchSave,
  trackNativeChatScratchExpiryCandidate
} from './native-chat-scratch-folder-lock'
import {
  attach,
  hostTestState
} from './agent-session-wire/structured-agent-session-host-test-harness'
import { HOST_TEST_SESSION } from './agent-session-wire/structured-agent-session-host-test-data'
import {
  scheduleNativeChatVisualsSweep,
  sweepNativeChatVisualsFolders,
  type NativeChatVisualsSweepDeps
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
  const folder = nativeChatScratchFolderFor(state, sessionId)
  mkdirSync(folder, { recursive: true })
  writeFileSync(join(folder, 'chart.html'), '<p>chart</p>')
  return folder
}

const DAY_MS = 24 * 60 * 60_000

/** Sets the mtime of `path` and everything under it to `daysAgo`, children before parents. */
function age(path: string, daysAgo = 40): void {
  if (statSync(path).isDirectory()) {
    for (const name of readdirSync(path)) {
      age(join(path, name), daysAgo)
    }
  }
  const at = new Date(Date.now() - daysAgo * DAY_MS)
  utimesSync(path, at, at)
}

function deps(
  state: string,
  held: readonly string[] | null,
  facts: { journal?: Record<string, number> } = {}
): NativeChatVisualsSweepDeps & {
  logger: { warn: ReturnType<typeof vi.fn<StructuredAgentSessionLogger['warn']>> }
  lanes: Map<string, Promise<void>>
} {
  const lanes = new Map<string, Promise<void>>()
  return {
    stateDirectory: state,
    listHeldSessionIds: () => held,
    lastJournalActivityAt: (sessionId) => facts.journal?.[sessionId] ?? null,
    // Stands in for the host's lane: one task at a time per chat.
    runWhileExecutionIdle: <T>(sessionId: string, task: () => Promise<T>) =>
      runKeyedSerializedOperation<T | null>(lanes, sessionId, task),
    lanes,
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

  it('expires a chat unused for 30 days and keeps one with recent use', async () => {
    const state = stateDirectory()
    const unused = visualsFor(state, 'chat-unused')
    const talkedTo = visualsFor(state, 'chat-journal')
    const edited = visualsFor(state, 'chat-nested')
    mkdirSync(join(edited, 'drafts'))
    writeFileSync(join(edited, 'drafts', 'v2.html'), '<p>v2</p>')
    age(nativeChatScratchRootFor(state))
    const fresh = new Date()
    utimesSync(join(edited, 'drafts', 'v2.html'), fresh, fresh)

    const result = await sweepNativeChatVisualsFolders(
      deps(state, ['chat-unused', 'chat-journal', 'chat-nested'], {
        journal: { 'chat-unused': Date.now() - 31 * DAY_MS, 'chat-journal': Date.now() - DAY_MS }
      })
    )

    expect(result).toEqual({ removed: 1, failed: 0 })
    expect(existsSync(unused)).toBe(false)
    expect(existsSync(`${unused}.expired`)).toBe(false)
    expect(existsSync(talkedTo)).toBe(true)
    expect(existsSync(edited)).toBe(true)
  })

  it('gives migrated files one fresh window and expires recovered conflicts with the chat', async () => {
    const state = stateDirectory()
    const legacyRoot = join(state, 'native-chat-visuals')
    const legacyFor = (sessionId: string, body: string): string => {
      const folder = join(legacyRoot, basename(nativeChatScratchFolderFor(state, sessionId)))
      mkdirSync(folder, { recursive: true })
      writeFileSync(join(folder, 'chart.html'), body)
      return folder
    }
    // Idle since long before the update: moved, and the first sweep must not take it.
    age(legacyFor('chat-old', '<p>old</p>'))
    age(legacyFor('chat-both', '<p>older</p>'))
    const both = visualsFor(state, 'chat-both')
    age(both)
    const { logger } = deps(state, [])
    await migrateLegacyNativeChatVisualsFolders(state, logger)

    const result = await sweepNativeChatVisualsFolders(
      deps(state, ['chat-old', 'chat-both'], { journal: { 'chat-old': Date.now() - 40 * DAY_MS } })
    )

    expect(result).toEqual({ removed: 0, failed: 0 })
    expect(
      readFileSync(join(nativeChatScratchFolderFor(state, 'chat-old'), 'chart.html'), 'utf8')
    ).toBe('<p>old</p>')
    expect(readFileSync(join(both, 'chart.html'), 'utf8')).toBe('<p>chart</p>')
    const recovery = readdirSync(both, { withFileTypes: true }).filter((entry) =>
      entry.isDirectory()
    )
    expect(recovery).toHaveLength(1)
    expect(readFileSync(join(both, recovery[0].name, 'files', 'chart.html'), 'utf8')).toBe(
      '<p>older</p>'
    )
    expect(existsSync(legacyRoot)).toBe(false)

    // A later install does not renew retention; both copies expire and nothing comes back.
    age(both)
    await migrateLegacyNativeChatVisualsFolders(state, logger)
    await expect(
      sweepNativeChatVisualsFolders(
        deps(state, ['chat-old', 'chat-both'], {
          journal: { 'chat-both': Date.now() - 40 * DAY_MS }
        })
      )
    ).resolves.toEqual({ removed: 1, failed: 0 })
    await migrateLegacyNativeChatVisualsFolders(state, logger)
    expect(existsSync(both)).toBe(false)
  })

  it('keeps a chat past 30 days while the host runs its agent', async () => {
    await attach()
    const state = stateDirectory()
    const folder = visualsFor(state, HOST_TEST_SESSION)
    age(folder)
    const result = await sweepNativeChatVisualsFolders({
      ...deps(state, [HOST_TEST_SESSION]),
      runWhileExecutionIdle: hostTestState().host.runWhileExecutionIdle
    })
    expect(result).toEqual({ removed: 0, failed: 0 })
    expect(existsSync(folder)).toBe(true)
  })

  it('gives a start queued behind expiry a fresh folder', async () => {
    const state = stateDirectory()
    const folder = visualsFor(state, 'chat-a')
    age(folder)
    const sweep = deps(state, ['chat-a'])
    const result = await sweepNativeChatVisualsFolders({
      ...sweep,
      runWhileExecutionIdle: (sessionId, task) => {
        const expiry = sweep.runWhileExecutionIdle(sessionId, task)
        // The start's own lane task, as the host's agent start runs it.
        void runKeyedSerializedOperation(sweep.lanes, sessionId, async () => {
          mkdirSync(folder, { recursive: true })
          writeFileSync(join(folder, 'new.html'), '<p>new</p>')
        })
        return expiry
      }
    })
    expect(result).toEqual({ removed: 1, failed: 0 })
    expect(readdirSync(folder)).toEqual(['new.html'])
    expect(existsSync(`${folder}.expired`)).toBe(false)
  })

  it('keeps a folder saved into after its age scan', async () => {
    const state = stateDirectory()
    const folder = visualsFor(state, 'chat-a')
    age(folder)
    const sweep = deps(state, ['chat-a'])
    await sweepNativeChatVisualsFolders({
      ...sweep,
      runWhileExecutionIdle: async (sessionId, task) => {
        // An overlapping sweep of the same folder ends first; this sweep's candidate must survive.
        trackNativeChatScratchExpiryCandidate(basename(folder)).dispose()
        // Settles between the scan and the locked recheck, which does not scan again.
        await runNativeChatScratchSave(state, join(folder, 'chart.html'), () =>
          writeFile(join(folder, 'chart.html'), '<p>saved</p>')
        )
        return sweep.runWhileExecutionIdle(sessionId, task)
      }
    })
    expect(readFileSync(join(folder, 'chart.html'), 'utf8')).toBe('<p>saved</p>')
  })

  it('removes nothing when the held chats cannot be read', async () => {
    const state = stateDirectory()
    const folder = visualsFor(state, 'chat-a')
    const legacy = join(state, 'native-chat-visuals', basename(folder))
    mkdirSync(legacy, { recursive: true })
    writeFileSync(join(legacy, 'chart.html'), '<p>awaiting migration retry</p>')
    await expect(sweepNativeChatVisualsFolders(deps(state, null))).resolves.toEqual({
      removed: 0,
      failed: 0
    })
    expect(existsSync(folder)).toBe(true)
    expect(readFileSync(join(legacy, 'chart.html'), 'utf8')).toBe('<p>awaiting migration retry</p>')
  })

  it('never touches entries it did not mint, symlinks included', async () => {
    const state = stateDirectory()
    const root = nativeChatScratchRootFor(state)
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
      'native-chat scratch folder could not be removed',
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
    symlinkSync(elsewhere, nativeChatScratchRootFor(state))
    await sweepNativeChatVisualsFolders(deps(state, []))
    expect(existsSync(join(elsewhere, 'a'.repeat(32)))).toBe(true)
  })
})
