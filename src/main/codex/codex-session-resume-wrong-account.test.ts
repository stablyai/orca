import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import type * as NodeFs from 'node:fs'
import type * as NodeFsPromises from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const statFaults = vi.hoisted(() => {
  const state = {
    held: new Set<string>(),
    reads: new Map<string, number>(),
    hold(path: string): void {
      state.held.add(path)
    },
    reset(): void {
      state.held.clear()
      state.reads.clear()
    },
    readsFor(path: string): number {
      return state.reads.get(path) ?? 0
    },
    consume(target: unknown): void {
      if (typeof target !== 'string' || !state.held.has(target)) {
        return
      }
      state.reads.set(target, (state.reads.get(target) ?? 0) + 1)
      const error: NodeJS.ErrnoException = new Error(
        `EBUSY: resource busy or locked, stat '${target}'`
      )
      error.code = 'EBUSY'
      error.syscall = 'stat'
      error.path = target
      throw error
    }
  }
  return state
})

const listingFaults = vi.hoisted(() => ({
  held: new Set<string>(),
  hold(path: string): void {
    listingFaults.held.add(path)
  },
  reset(): void {
    listingFaults.held.clear()
  }
}))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>()
  const originalStat = actual.statSync as (...args: unknown[]) => unknown
  const patched: Record<string, unknown> = {
    ...actual,
    statSync: Object.assign((...args: unknown[]): unknown => {
      statFaults.consume(args[0])
      return originalStat(...args)
    }, originalStat)
  }
  return { ...patched, default: patched }
})

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFsPromises>()
  return {
    ...actual,
    opendir: async (...args: Parameters<typeof actual.opendir>) => {
      if (typeof args[0] === 'string' && listingFaults.held.has(args[0])) {
        const error: NodeJS.ErrnoException = new Error(
          `EBUSY: resource busy or locked, opendir '${args[0]}'`
        )
        error.code = 'EBUSY'
        error.syscall = 'opendir'
        error.path = args[0]
        throw error
      }
      return actual.opendir(...args)
    }
  }
})

const { findTrustedCodexSessionResume } = await import('./codex-session-resume-home')
const { ManagedCodexHomeTemporarilyUnavailableError } =
  await import('../codex-accounts/host-codex-managed-home-ownership')

const tempRoots: string[] = []
const SESSION_ID = '11111111-2222-3333-4444-555555555555'

function makeHomeWithRollout(root: string, name: string): string {
  const homePath = join(root, name)
  const datedDir = join(homePath, 'sessions', '2026', '07', '20')
  mkdirSync(datedDir, { recursive: true })
  writeFileSync(join(datedDir, `rollout-${SESSION_ID}.jsonl`), '{}\n', 'utf-8')
  return homePath
}

beforeEach(() => {
  statFaults.reset()
  listingFaults.reset()
})

afterEach(() => {
  statFaults.reset()
  listingFaults.reset()
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('STA-4607 session resume under a briefly unreadable sessions tree', () => {
  it('refuses rather than resuming the selected account under another account home', async () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-sta4607-'))
    tempRoots.push(root)
    const selectedHome = makeHomeWithRollout(root, 'account-a')
    const otherHome = makeHomeWithRollout(root, 'account-b')

    const args = {
      sessionId: SESSION_ID,
      transcriptPath: undefined,
      trustedCodexHomes: [selectedHome, otherHome],
      getSelectedAccountCodexHome: (): string | null => selectedHome,
      systemCodexHomePath: null,
      sharedRuntimeCodexHomePath: null
    }

    await expect(findTrustedCodexSessionResume(args)).resolves.toEqual({
      homePath: selectedHome,
      transcriptPath: join(
        selectedHome,
        'sessions',
        '2026',
        '07',
        '20',
        `rollout-${SESSION_ID}.jsonl`
      )
    })

    const selectedSessionsRoot = join(selectedHome, 'sessions')
    statFaults.hold(selectedSessionsRoot)

    await expect(findTrustedCodexSessionResume(args)).rejects.toBeInstanceOf(
      ManagedCodexHomeTemporarilyUnavailableError
    )
    expect(statFaults.readsFor(selectedSessionsRoot)).toBeGreaterThan(0)
  })

  it('still skips a definitively absent sessions tree', async () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-sta4607-'))
    tempRoots.push(root)
    const selectedHome = join(root, 'account-a-no-sessions')
    mkdirSync(selectedHome, { recursive: true })
    const otherHome = makeHomeWithRollout(root, 'account-b')

    await expect(
      findTrustedCodexSessionResume({
        sessionId: SESSION_ID,
        transcriptPath: undefined,
        trustedCodexHomes: [selectedHome, otherHome],
        getSelectedAccountCodexHome: (): string | null => selectedHome,
        systemCodexHomePath: null,
        sharedRuntimeCodexHomePath: null
      })
    ).resolves.toEqual({
      homePath: otherHome,
      transcriptPath: join(otherHome, 'sessions', '2026', '07', '20', `rollout-${SESSION_ID}.jsonl`)
    })
  })

  it('refuses when the selected tree locks during listing after stat succeeds', async () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-sta4607-'))
    tempRoots.push(root)
    const selectedHome = makeHomeWithRollout(root, 'account-a')
    const otherHome = makeHomeWithRollout(root, 'account-b')
    const selectedSessionsRoot = join(selectedHome, 'sessions')
    listingFaults.hold(selectedSessionsRoot)

    await expect(
      findTrustedCodexSessionResume({
        sessionId: SESSION_ID,
        transcriptPath: undefined,
        trustedCodexHomes: [selectedHome, otherHome],
        getSelectedAccountCodexHome: (): string | null => selectedHome,
        systemCodexHomePath: null,
        sharedRuntimeCodexHomePath: null
      })
    ).rejects.toBeInstanceOf(ManagedCodexHomeTemporarilyUnavailableError)
  })

  it('refuses when a NESTED dated directory locks and the root stats fine', async () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-sta4607-'))
    tempRoots.push(root)
    const selectedHome = makeHomeWithRollout(root, 'account-a')
    const otherHome = makeHomeWithRollout(root, 'account-b')
    listingFaults.hold(join(selectedHome, 'sessions', '2026', '07', '20'))

    await expect(
      findTrustedCodexSessionResume({
        sessionId: SESSION_ID,
        transcriptPath: undefined,
        trustedCodexHomes: [selectedHome, otherHome],
        getSelectedAccountCodexHome: (): string | null => selectedHome,
        systemCodexHomePath: null,
        sharedRuntimeCodexHomePath: null
      })
    ).rejects.toBeInstanceOf(ManagedCodexHomeTemporarilyUnavailableError)
  })

  it('skips an unreadable home that is NOT the selected account', async () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-sta4607-'))
    tempRoots.push(root)
    const selectedHome = join(root, 'account-a-empty')
    mkdirSync(join(selectedHome, 'sessions'), { recursive: true })
    const otherHome = makeHomeWithRollout(root, 'account-b')
    const unrelatedHome = makeHomeWithRollout(root, 'account-c')

    statFaults.hold(join(unrelatedHome, 'sessions'))

    await expect(
      findTrustedCodexSessionResume({
        sessionId: SESSION_ID,
        transcriptPath: undefined,
        trustedCodexHomes: [selectedHome, unrelatedHome, otherHome],
        getSelectedAccountCodexHome: (): string | null => selectedHome,
        systemCodexHomePath: null,
        sharedRuntimeCodexHomePath: null
      })
    ).resolves.toEqual({
      homePath: otherHome,
      transcriptPath: join(otherHome, 'sessions', '2026', '07', '20', `rollout-${SESSION_ID}.jsonl`)
    })
  })
})
