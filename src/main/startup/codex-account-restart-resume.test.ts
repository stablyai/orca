import { dirname, join } from 'node:path'
import { linkSync, readFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const homes = vi.hoisted(() => ({ original: '', selected: '', system: '' }))
vi.mock('electron', () => ({ app: { getPath: () => homes.system } }))
vi.mock('./main-process-state', () => ({
  mainProcessState: {
    codexRuntimeHome: {
      isHostSystemDefaultRealHomeSelected: () => false,
      getHostCodexHomePathsForSessionDiscovery: () => [homes.original, homes.selected],
      resolveSelectedHostAccountCodexHomePathForResume: () => homes.selected || null
    },
    store: { getSettings: () => ({}) }
  }
}))
vi.mock('../codex/hook-service', () => ({
  codexHookService: {
    installForLaunchPrep: vi.fn(),
    refreshRuntimeUserHooksForLaunchPrep: vi.fn()
  }
}))
vi.mock('../codex/codex-hook-reconcile', () => ({ reconcileCodexHooksForLaunch: vi.fn() }))
vi.mock('../codex/codex-home-paths', () => ({
  getCodexSessionBackfillStateDirPath: () => join(homes.system, 'backfill'),
  getSystemCodexHomePath: () => homes.system,
  getOrcaManagedCodexHomePath: () => join(homes.system, 'legacy')
}))
vi.mock('../codex/codex-config-mirror', () => ({ ensureCodexDaemonSocketGuard: vi.fn() }))

import { prepareCodexSessionResumeForLaunch } from './codex-session-resume-launch'

let root: string
let transcriptPath: string
const sessionId = 'abcdef00-1234-4321-9999-cafecafecafe'
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-account-restart-'))
  homes.original = join(root, 'codex-accounts', 'old', 'home')
  homes.selected = join(root, 'codex-accounts', 'new', 'home')
  homes.system = join(root, 'system')
  const relativePath = join('sessions', '2026', '10', '05', `rollout-${sessionId}.jsonl`)
  transcriptPath = join(homes.original, relativePath)
  const bridged = join(homes.selected, relativePath)
  mkdirSync(dirname(transcriptPath), { recursive: true })
  mkdirSync(dirname(bridged), { recursive: true })
  writeFileSync(transcriptPath, '{"type":"session_meta"}\n')
  linkSync(transcriptPath, bridged)
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

it('resumes an explicit account restart in the selected home using the bridged transcript', async () => {
  const result = await prepareCodexSessionResumeForLaunch({
    providerSession: { key: 'session_id', id: sessionId, transcriptPath },
    target: { runtime: 'host' },
    useSelectedAccount: true
  })
  expect(result).toMatchObject({ outcome: 'resume', codexHomePath: homes.selected })
})

it('keeps ordinary automatic restores pinned to their original account', async () => {
  const result = await prepareCodexSessionResumeForLaunch({
    providerSession: { key: 'session_id', id: sessionId, transcriptPath },
    target: { runtime: 'host' }
  })
  expect(result).toMatchObject({ outcome: 'resume', codexHomePath: homes.original })
})

it('materializes a rollout when the account bridge has not caught up', async () => {
  rmSync(join(homes.selected, 'sessions'), { recursive: true })
  const result = await prepareCodexSessionResumeForLaunch({
    providerSession: { key: 'session_id', id: sessionId, transcriptPath },
    target: { runtime: 'host' },
    useSelectedAccount: true
  })
  expect(result).toMatchObject({ codexHomePath: homes.selected })
  expect(readFileSync(transcriptPath.replace(homes.original, homes.selected), 'utf8')).toBe(
    readFileSync(transcriptPath, 'utf8')
  )
})

it('refuses a conflicting target rollout instead of restarting the old account', async () => {
  const target = transcriptPath.replace(homes.original, homes.selected)
  rmSync(target)
  writeFileSync(target, 'another session')
  await expect(
    prepareCodexSessionResumeForLaunch({
      providerSession: { key: 'session_id', id: sessionId, transcriptPath },
      target: { runtime: 'host' },
      useSelectedAccount: true
    })
  ).rejects.toThrow('different rollout')
  expect(readFileSync(target, 'utf8')).toBe('another session')
})

it('uses the system home when an explicit restart follows deselection', async () => {
  homes.selected = ''
  const result = await prepareCodexSessionResumeForLaunch({
    providerSession: { key: 'session_id', id: sessionId, transcriptPath },
    target: { runtime: 'host' },
    useSelectedAccount: true
  })
  expect(result).toMatchObject({ codexHomePath: homes.system })
})

it('leaves WSL preparation on the execution host', async () => {
  expect(
    await prepareCodexSessionResumeForLaunch({
      providerSession: { key: 'session_id', id: sessionId, transcriptPath },
      target: { runtime: 'wsl', wslDistro: 'Ubuntu' },
      useSelectedAccount: true
    })
  ).toBeNull()
})
