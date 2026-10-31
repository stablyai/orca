import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  acquiredAccountAcrossLease,
  acquiredCodexSessionAccount,
  withAcquiredAgentSessionAccount
} from '../../shared/agent-session-acquired-account'
import { codexProviderHandle } from '../../shared/agent-session-provider-handle-encoding'
import type { AgentSessionJournalIdentity } from '../../shared/agent-session-journal-types'
import { agentSessionRecordFixture } from '../native-chat/agent-session-record-test-fixture'
import { createCodexStructuredLaunchResolver } from '../runtime/structured-agent-launch-composition.test-support'
import { prepareCodexStructuredAccountHome } from './codex-structured-account-home'

const THREAD = '01a18767-8a57-7002-92e4-ead2476d8da6'
const relativeRollout = join(
  'sessions',
  '2026',
  '10',
  '31',
  `rollout-2026-10-31T10-00-00-${THREAD}.jsonl`
)
const account = (path: string) => ({ variable: 'CODEX_HOME', path })
const identity: AgentSessionJournalIdentity = {
  sessionId: 'account-transition',
  workspaceId: 'workspace-1',
  hostId: 'local',
  agent: 'codex',
  providerHandle: codexProviderHandle(THREAD)
}

describe('native Codex account transitions', () => {
  let root: string
  let source: string
  let target: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'orca-native-codex-account-'))
    vi.stubEnv('ORCA_USER_DATA_PATH', join(root, 'orca-state'))
    source = join(root, 'account-a')
    target = join(root, 'account-b')
    await Promise.all([mkdir(source), mkdir(target)])
  })

  afterEach(async () => {
    vi.unstubAllEnvs()
    await rm(root, { recursive: true, force: true })
  })

  const record = () =>
    agentSessionRecordFixture({
      sessionId: 'account-transition',
      provider: 'codex',
      accountHome: account(source),
      providerHandleChain: [
        {
          linkId: 'proven-thread',
          handle: codexProviderHandle(THREAD),
          origin: 'resumed',
          mintedAtFence: 1,
          observedAt: 1
        }
      ]
    })

  async function rollout(home: string, text: string) {
    const path = join(home, relativeRollout)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, text)
    return path
  }

  it('resumes the same conversation with selected credentials without copying either login', async () => {
    const transcript = await rollout(source, 'original conversation\n')
    await writeFile(join(source, 'auth.json'), 'account-a-login')
    await writeFile(join(target, 'auth.json'), 'account-b-login')
    const value = record()
    const resolve = createCodexStructuredLaunchResolver({
      store: { getRecord: () => value, pinLaunchDirectory: vi.fn() },
      resolveAccountHome: async () => account(target),
      resolveCommand: () => ({ command: 'codex', prefixArgs: [] }),
      resolveLaunchArgs: () => [],
      resolveEnvironment: async () => ({ CODEX_HOME: source })
    })

    const launch = await resolve({ identity })
    expect(launch).toMatchObject({
      codexHome: target,
      resumeThreadId: THREAD,
      env: { CODEX_HOME: target }
    })
    expect(await readFile(join(target, relativeRollout), 'utf8')).toBe(
      await readFile(transcript, 'utf8')
    )
    expect(await readFile(join(source, 'auth.json'), 'utf8')).toBe('account-a-login')
    expect(await readFile(join(target, 'auth.json'), 'utf8')).toBe('account-b-login')
  })

  it.each(['created', 'resumed'] as const)(
    'refuses missing %s history before resolving a process instead of using the old account',
    async (origin) => {
      const resolveCommand = vi.fn(() => ({ command: 'codex', prefixArgs: [] }))
      const value = record()
      value.providerHandleChain = value.providerHandleChain.map((link) => ({ ...link, origin }))
      const resolve = createCodexStructuredLaunchResolver({
        store: { getRecord: () => value, pinLaunchDirectory: vi.fn() },
        resolveAccountHome: async () => account(target),
        resolveCommand,
        resolveLaunchArgs: () => []
      })
      await expect(resolve({ identity })).rejects.toThrow('conversation history is unavailable')
      expect(resolveCommand).not.toHaveBeenCalled()
    }
  )

  it('launches a fresh chat on the selected account without requiring a founding rollout', async () => {
    const value = { ...record(), providerHandleChain: [] }
    await expect(prepareCodexStructuredAccountHome(value, account(target))).resolves.toEqual(
      account(target)
    )
  })

  it('refuses an unavailable selected account instead of launching on the founding account', async () => {
    const value = record()
    const resolveCommand = vi.fn(() => ({ command: 'codex', prefixArgs: [] }))
    const resolve = createCodexStructuredLaunchResolver({
      store: { getRecord: () => value, pinLaunchDirectory: vi.fn() },
      resolveAccountHome: async () => {
        throw new Error('Selected account unavailable')
      },
      resolveCommand,
      resolveLaunchArgs: () => []
    })
    await expect(resolve({ identity })).rejects.toThrow('Selected account unavailable')
    expect(resolveCommand).not.toHaveBeenCalled()
  })

  it('refuses conflicting histories and leaves both conversations intact', async () => {
    const original = await rollout(source, 'original\n')
    const conflicting = await rollout(target, 'different conversation\n')
    await expect(prepareCodexStructuredAccountHome(record(), account(target))).rejects.toThrow(
      'different rollout'
    )
    expect(await readFile(original, 'utf8')).toBe('original\n')
    expect(await readFile(conflicting, 'utf8')).toBe('different conversation\n')
  })

  it('refuses an unresolved launch account instead of treating it as the founding account', async () => {
    await expect(prepareCodexStructuredAccountHome(record(), null)).rejects.toThrow(
      'selected Codex account is unavailable'
    )
  })

  it('uses the last proved account after release and restart, including when the founding home is gone', async () => {
    await rollout(target, 'latest conversation in b\n')
    const value = record()
    const live = {
      ...value,
      lease: {
        ...value.lease,
        ownerProcess: { hostId: 'local', pid: 42, processStartTimeMs: 10, spawnToken: 'spawn-b' }
      }
    }
    const acquired = withAcquiredAgentSessionAccount(live, {
      generation: 'generation-b',
      home: account(target)
    })
    const lease = { ...acquired.lease, runtimeFence: 2, ownerProcess: null }
    const reloaded = JSON.parse(
      JSON.stringify({
        ...acquired,
        lease,
        acquiredAccount: acquiredAccountAcrossLease(acquired, lease)
      })
    )
    const next = join(root, 'account-c')
    expect(acquiredCodexSessionAccount(reloaded)?.recipe.home).toBe(target)
    await expect(prepareCodexStructuredAccountHome(reloaded, account(next))).resolves.toEqual(
      account(next)
    )
    expect(await readFile(join(next, relativeRollout), 'utf8')).toBe('latest conversation in b\n')
    expect(acquiredCodexSessionAccount({ ...reloaded, sessionId: 'another-chat' })).toBeNull()
  })
})
