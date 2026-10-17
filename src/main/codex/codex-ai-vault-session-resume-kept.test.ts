import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, linkSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { prepareCodexAiVaultSessionResume } from './codex-ai-vault-session-resume'

const ROLLOUT = join('sessions', '2026', '10', '14', 'rollout-2026-10-14T10-00-00-abc.jsonl')

describe('Session History resume of a kept Codex conversation', () => {
  let root: string
  let homeA: string
  let homeB: string
  let homeC: string
  let preparePinnedLaunchHome: ReturnType<typeof vi.fn<(home: string) => Promise<void>>>

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'orca-ai-vault-kept-'))
    vi.stubEnv('ORCA_USER_DATA_PATH', join(root, 'user-data'))
    homeA = join(root, 'codex-accounts', 'account-a', 'home')
    homeB = join(root, 'codex-accounts', 'account-b', 'home')
    homeC = join(root, 'codex-accounts', 'account-c', 'home')
    mkdirSync(dirname(join(homeA, ROLLOUT)), { recursive: true })
    mkdirSync(dirname(join(homeB, ROLLOUT)), { recursive: true })
    mkdirSync(homeC, { recursive: true })
    writeFileSync(join(homeA, ROLLOUT), '{"type":"session_meta"}\n')
    linkSync(join(homeA, ROLLOUT), join(homeB, ROLLOUT))
    preparePinnedLaunchHome = vi.fn(async () => undefined)
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    rmSync(root, { recursive: true, force: true })
  })

  function prepare(options: {
    keptHome: () => string | undefined
    selectedHome?: string
    fork?: boolean
    discoveryHomes?: string[]
  }) {
    const resolveKeptCodexHome = vi.fn(options.keptHome)
    const result = prepareCodexAiVaultSessionResume(
      {
        agent: 'codex',
        sessionId: 'abc',
        filePath: join(homeA, ROLLOUT),
        codexHome: homeA,
        executionHostId: 'local',
        ...(options.fork ? { fork: true } : {})
      },
      {
        runtimeHome: {
          isHostSystemDefaultRealHomeSelected: () => false,
          resolveSelectedHostAccountCodexHomePathForResume: () => options.selectedHome ?? homeB,
          getHostCodexHomePathsForSessionDiscovery: () =>
            options.discoveryHomes ?? [homeA, homeB, homeC]
        },
        systemCodexHomePath: join(root, 'system-codex-home'),
        preparePinnedLaunchHome,
        resolveKeptCodexHome
      }
    )
    return { result, resolveKeptCodexHome }
  }

  it('stays on the kept account instead of following the selection', async () => {
    await expect(prepare({ keptHome: () => homeA }).result).resolves.toEqual({
      useRealCodexHome: false
    })
  })

  it('retargets to the kept account when the listing named another alias', async () => {
    await expect(prepare({ keptHome: () => homeB, selectedHome: homeA }).result).resolves.toEqual({
      useRealCodexHome: false,
      substituteCodexHome: homeB
    })
  })

  it('moves the conversation into a kept home that does not hold it yet', async () => {
    await expect(prepare({ keptHome: () => homeC }).result).resolves.toEqual({
      useRealCodexHome: false,
      substituteCodexHome: homeC
    })
    expect(existsSync(join(homeC, ROLLOUT))).toBe(true)
    expect(preparePinnedLaunchHome).toHaveBeenCalledWith(homeC)
  })

  it('refuses to copy from a home this host does not list', async () => {
    await expect(
      prepare({ keptHome: () => homeC, discoveryHomes: [homeB] }).result
    ).rejects.toThrow(/could not move this conversation/)
    expect(existsSync(join(homeC, ROLLOUT))).toBe(false)
  })

  it('refuses when the keep cannot be read', async () => {
    const refusal = new Error('Orca could not read which account this agent is kept on.')
    await expect(
      prepare({
        keptHome: () => {
          throw refusal
        }
      }).result
    ).rejects.toBe(refusal)
  })

  it('leaves a fork, which is a new conversation, to the selection', async () => {
    const { result, resolveKeptCodexHome } = prepare({ keptHome: () => homeC, fork: true })
    await expect(result).resolves.toEqual({ useRealCodexHome: false, substituteCodexHome: homeB })
    expect(resolveKeptCodexHome).not.toHaveBeenCalled()
  })
})
