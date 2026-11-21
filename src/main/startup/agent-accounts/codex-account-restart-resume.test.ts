import { basename, dirname, join } from 'node:path'
import {
  linkSync,
  readFileSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const homes = vi.hoisted(() => ({ original: '', selected: '', system: '' }))
vi.mock('../../codex/trust/project-trust/codex-project-trust-worker-spawn', async () => ({
  spawnCodexProjectTrustWorker: (
    await import('../../codex/trust/project-trust/codex-project-trust-worker.test-fixture')
  ).codexProjectTrustTestWorker.factory
}))
vi.mock('electron', () => ({ app: { getPath: () => homes.system } }))
vi.mock('../main-process-state', () => ({
  mainProcessState: {
    core: {
      codexRuntimeHome: {
        isHostSystemDefaultRealHomeSelected: () => false,
        prepareAccountHistoryForPinnedHome: async () => {},
        getHostCodexHomePathsForSessionDiscovery: () => [
          homes.original,
          homes.selected,
          join(homes.system, 'legacy')
        ],
        resolveSelectedHostAccountCodexHomePathForResume: () => homes.selected || null
      }
    },
    store: { getSettings: () => ({}) }
  }
}))
vi.mock('../../codex/hooks/installation/hook-service', () => ({
  codexHookService: {
    installForLaunchPrep: vi.fn(),
    refreshRuntimeUserHooksForLaunchPrep: vi.fn()
  }
}))
vi.mock('../../codex/hooks/reconciliation/codex-hook-reconcile', () => ({
  reconcileCodexHooksForLaunch: vi.fn()
}))
vi.mock('../../codex/configuration/homes/codex-home-paths', () => ({
  getCodexSessionBackfillStateDirPath: () => join(homes.system, 'backfill'),
  getSystemCodexHomePath: () => homes.system,
  getOrcaManagedCodexHomePath: () => join(homes.system, 'legacy'),
  resolveOrcaManagedCodexHomePath: () => join(homes.system, 'legacy')
}))
vi.mock('../../codex/configuration/settings/codex-config-mirror', () => ({
  ensureCodexDaemonSocketGuard: vi.fn()
}))

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

it('resumes a legacy copy that a stopped swap left moved aside', async () => {
  const relativePath = join('2026', '10', '05', `rollout-2026-10-05T10-00-00-${sessionId}.jsonl`)
  const legacyHome = join(homes.system, 'legacy')
  const source = join(homes.system, 'sessions', relativePath)
  const copy = join(legacyHome, 'sessions', relativePath)
  mkdirSync(dirname(source), { recursive: true })
  mkdirSync(dirname(copy), { recursive: true })
  writeFileSync(source, '{"turn":1}\n{"turn":2}\n')
  writeFileSync(copy, '{"turn":1}\n')
  const marker = join(legacyHome, '.orca-session-copies', `${relativePath}.json`)
  mkdirSync(dirname(marker), { recursive: true })
  writeFileSync(
    marker,
    JSON.stringify({
      sourcePath: source,
      sourceSize: 22,
      sourceMtimeMs: 0,
      targetSize: 11,
      targetMtimeMs: 0,
      aside: `${basename(copy)}.orca-legacy-copy.1`
    })
  )
  renameSync(copy, `${copy}.orca-legacy-copy.1`)

  const result = await prepareCodexSessionResumeForLaunch({
    providerSession: { key: 'session_id', id: sessionId, transcriptPath: copy },
    target: { runtime: 'host' }
  })

  expect(result).toMatchObject({ outcome: 'resume', codexHomePath: legacyHome })
  expect(readFileSync(copy, 'utf-8')).toContain('{"turn":1}')
})

it('refuses to resume as a fresh chat while a copy moved aside has an unreadable marker', async () => {
  const relativePath = join('2026', '10', '05', `rollout-2026-10-05T10-00-00-${sessionId}.jsonl`)
  const legacyHome = join(homes.system, 'legacy')
  const copy = join(legacyHome, 'sessions', relativePath)
  mkdirSync(dirname(copy), { recursive: true })
  writeFileSync(`${copy}.orca-legacy-copy.1`, '{"turn":1}\n')
  // A marker that exists but can't be read as a file.
  mkdirSync(join(legacyHome, '.orca-session-copies', `${relativePath}.json`), { recursive: true })

  await expect(
    prepareCodexSessionResumeForLaunch({
      providerSession: { key: 'session_id', id: sessionId, transcriptPath: copy },
      target: { runtime: 'host' }
    })
  ).rejects.toThrow(/Retry resume/)
})
