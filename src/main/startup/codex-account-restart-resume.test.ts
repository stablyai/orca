import { dirname, join } from 'node:path'
import {
  existsSync,
  readFileSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { prepareCodexLaunchHome } from '../codex/codex-legacy-session-resume'
import { codexConversationStore } from '../codex/codex-launch-home'

const homes = vi.hoisted(() => ({ original: '', selected: '', system: '' }))
vi.mock('electron', () => ({ app: { getPath: () => homes.system } }))
vi.mock('./main-process-state', () => ({
  mainProcessState: {
    codexRuntimeHome: {
      isHostSystemDefaultRealHomeSelected: () => false,
      getHostCodexHomePathsForSessionDiscovery: () => [homes.original],
      resolveSelectedHostAccountCodexHomePathForResume: () => homes.selected || null,
      prepareForCodexLaunchAsync: async (
        _target: unknown,
        _env: unknown,
        options: { conversationHome: string; transcriptPath: string }
      ) =>
        (await prepareCodexLaunchHome({
          selectedAccount: homes.selected ? { homePath: homes.selected } : null,
          conversationHome: options.conversationHome,
          transcriptPath: options.transcriptPath,
          systemHome: homes.system,
          accountsRoot: join(homes.system, 'codex-accounts')
        })) ?? null
    },
    store: { getSettings: () => ({}) }
  }
}))
vi.mock('../codex/hook-service', () => ({
  codexHookService: { installForLaunchPrep: vi.fn(), refreshRuntimeUserHooksForLaunchPrep: vi.fn() }
}))
vi.mock('../codex/codex-hook-reconcile', () => ({ reconcileCodexHooksForLaunch: vi.fn() }))
vi.mock('../codex/codex-home-paths', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getCodexSessionBackfillStateDirPath: () => join(homes.system, 'backfill'),
  getSystemCodexHomePath: () => homes.system,
  getOrcaManagedCodexHomePath: () => join(homes.system, 'legacy')
}))
vi.mock('../codex/codex-config-mirror', () => ({
  ensureCodexDaemonSocketGuard: vi.fn(),
  syncSystemConfigIntoManagedCodexHome: vi.fn()
}))

import { prepareCodexSessionResumeForLaunch } from './codex-session-resume-launch'

let root: string
let transcriptPath: string
const sessionId = 'abcdef00-1234-4321-9999-cafecafecafe'
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'orca-account-restart-')))
  homes.original = join(root, 'codex-accounts', 'old', 'home')
  homes.selected = join(root, 'codex-accounts', 'new', 'home')
  homes.system = join(root, 'system')
  transcriptPath = join(
    homes.original,
    'sessions',
    '2026',
    '10',
    '05',
    `rollout-${sessionId}.jsonl`
  )
  mkdirSync(dirname(transcriptPath), { recursive: true })
  mkdirSync(homes.selected, { recursive: true })
  mkdirSync(homes.system, { recursive: true })
  writeFileSync(join(homes.selected, 'auth.json'), '{"selected":true}')
  writeFileSync(join(homes.system, 'auth.json'), '{"system":true}')
  writeFileSync(transcriptPath, '{"type":"session_meta"}\n')
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

it.each([true, false])(
  'resumes in the original store with the selected login (explicit restart: %s)',
  async (useSelectedAccount) => {
    const result = await prepareCodexSessionResumeForLaunch({
      providerSession: { key: 'session_id', id: sessionId, transcriptPath },
      target: { runtime: 'host' },
      useSelectedAccount
    })
    expect(result?.outcome).toBe('resume')
    if (result?.outcome !== 'resume') {
      throw new Error('Expected a resume')
    }
    expect(codexConversationStore(result.codexHomePath)).toBe(homes.original)
    expect(readFileSync(join(result.codexHomePath, 'auth.json'), 'utf8')).toBe('{"selected":true}')
    expect(existsSync(join(homes.selected, 'sessions'))).toBe(false)
    expect(readFileSync(transcriptPath, 'utf8')).toBe('{"type":"session_meta"}\n')
  }
)

it('uses the system login over the original store after deselection', async () => {
  homes.selected = ''
  const result = await prepareCodexSessionResumeForLaunch({
    providerSession: { key: 'session_id', id: sessionId, transcriptPath },
    target: { runtime: 'host' },
    useSelectedAccount: true
  })
  if (result?.outcome !== 'resume') {
    throw new Error('Expected a resume')
  }
  expect(codexConversationStore(result.codexHomePath)).toBe(homes.original)
  expect(readFileSync(join(result.codexHomePath, 'auth.json'), 'utf8')).toBe('{"system":true}')
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

it('returns terminal System-default inputs only after the no-file rollout is ready', async () => {
  homes.selected = ''
  unlinkSync(join(homes.system, 'auth.json'))
  const result = await prepareCodexSessionResumeForLaunch({
    providerSession: { key: 'session_id', id: sessionId, transcriptPath },
    target: { runtime: 'host' }
  })
  expect(result).toMatchObject({ outcome: 'resume', codexHomePath: homes.system })
  const copied = join(homes.system, 'sessions', '2026', '10', '05', `rollout-${sessionId}.jsonl`)
  expect(readFileSync(copied, 'utf8')).toBe(readFileSync(transcriptPath, 'utf8'))
  unlinkSync(copied)
  writeFileSync(copied, 'conflict')
  await expect(
    prepareCodexSessionResumeForLaunch({
      providerSession: { key: 'session_id', id: sessionId, transcriptPath },
      target: { runtime: 'host' }
    })
  ).rejects.toThrow('Retry resume')
  expect(readFileSync(copied, 'utf8')).toBe('conflict')
})
