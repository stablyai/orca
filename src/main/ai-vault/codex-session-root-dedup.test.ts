import { describe, expect, it } from 'vitest'
import type { AiVaultSession } from '../../shared/ai-vault-types'
import {
  dedupeCodexRolloutFileAliases,
  dedupeCodexSessionsBySessionId
} from './codex-session-root-dedup'

const REAL_HOME_ROLLOUT =
  '/Users/ada/.codex/sessions/2026/07/01/rollout-2026-07-01T10-00-00-019f0000-1111-7222-8333-444444444444.jsonl'
const MANAGED_HOME_ROLLOUT =
  '/Users/ada/Library/Application Support/orca/codex-runtime-home/home/sessions/2026/07/01/rollout-2026-07-01T10-00-00-019f0000-1111-7222-8333-444444444444.jsonl'
const MANAGED_HOME = '/Users/ada/Library/Application Support/orca/codex-runtime-home/home'

function codexSession(overrides: Partial<AiVaultSession>): AiVaultSession {
  return {
    id: `local:codex:${overrides.sessionId ?? 'session-1'}:${overrides.filePath ?? '/tmp/x.jsonl'}`,
    executionHostId: 'local',
    agent: 'codex',
    sessionId: 'session-1',
    title: 'Session',
    cwd: '/repo/app',
    branch: null,
    model: null,
    filePath: '/tmp/x.jsonl',
    codexHome: null,
    createdAt: '2026-07-01T10:00:00.000Z',
    updatedAt: '2026-07-01T10:05:00.000Z',
    modifiedAt: '2026-07-01T10:05:00.000Z',
    messageCount: 1,
    totalTokens: 10,
    previewMessages: [],
    queuedMessageCount: 0,
    subagentTranscriptCount: 0,
    resumeCommand: 'codex resume session-1',
    subagent: null,
    ...overrides
  } as AiVaultSession
}

describe('dedupeCodexRolloutFileAliases', () => {
  type Candidate = {
    agent: string
    path: string
    codexHome: string | null
    hardlinkIdentity?: string
  }
  const accessors = {
    isCodex: (candidate: Candidate) => candidate.agent === 'codex',
    getFilePath: (candidate: Candidate) => candidate.path,
    getCodexHome: (candidate: Candidate) => candidate.codexHome,
    getHardlinkIdentity: (candidate: Candidate) => candidate.hardlinkIdentity ?? null
  }

  it('keeps the real-home alias when the same rollout exists in both roots', () => {
    const managed = {
      agent: 'codex',
      path: MANAGED_HOME_ROLLOUT,
      codexHome: MANAGED_HOME,
      hardlinkIdentity: '1:42'
    }
    const real = {
      agent: 'codex',
      path: REAL_HOME_ROLLOUT,
      codexHome: null,
      hardlinkIdentity: '1:42'
    }
    expect(dedupeCodexRolloutFileAliases([managed, real], accessors)).toEqual([real])
    expect(dedupeCodexRolloutFileAliases([real, managed], accessors)).toEqual([real])
  })

  it('prefers the managed runtime home over other non-default homes', () => {
    const managed = {
      agent: 'codex',
      path: `\\\\wsl$\\Ubuntu\\home\\ada\\.local\\share\\orca\\codex-runtime-home\\home\\sessions\\2026\\07\\01\\rollout-2026-07-01T10-00-00-019f0000-1111-7222-8333-444444444444.jsonl`,
      codexHome: '\\\\wsl$\\Ubuntu\\home\\ada\\.local\\share\\orca\\codex-runtime-home\\home',
      hardlinkIdentity: '1:42'
    }
    const wslReal = {
      agent: 'codex',
      path: `\\\\wsl$\\Ubuntu\\home\\ada\\.codex\\sessions\\2026\\07\\01\\rollout-2026-07-01T10-00-00-019f0000-1111-7222-8333-444444444444.jsonl`,
      codexHome: '\\\\wsl$\\Ubuntu\\home\\ada\\.codex',
      hardlinkIdentity: '1:42'
    }
    expect(dedupeCodexRolloutFileAliases([wslReal, managed], accessors)).toEqual([managed])
  })

  it('recognizes the managed runtime home with backslash separators', () => {
    const managed = {
      agent: 'codex',
      path: 'C:\\Users\\ada\\AppData\\Roaming\\orca\\codex-runtime-home\\home\\sessions\\2026\\07\\01\\rollout-2026-07-01T10-00-00-019f0000-1111-7222-8333-444444444444.jsonl',
      codexHome: 'C:\\Users\\ada\\AppData\\Roaming\\orca\\codex-runtime-home\\home',
      hardlinkIdentity: '7:9'
    }
    const custom = {
      agent: 'codex',
      path: 'D:\\codex\\sessions\\2026\\07\\01\\rollout-2026-07-01T10-00-00-019f0000-1111-7222-8333-444444444444.jsonl',
      codexHome: 'D:\\codex',
      hardlinkIdentity: '7:9'
    }
    expect(dedupeCodexRolloutFileAliases([custom, managed], accessors)).toEqual([managed])
  })

  it('keeps distinct rollouts, non-codex candidates, and non-rollout file names', () => {
    const real = { agent: 'codex', path: REAL_HOME_ROLLOUT, codexHome: null }
    const other = {
      agent: 'codex',
      path: '/Users/ada/.codex/sessions/2026/07/02/rollout-2026-07-02T09-00-00-029f0000-1111-7222-8333-555555555555.jsonl',
      codexHome: null
    }
    const oddName = {
      agent: 'codex',
      path: `${MANAGED_HOME}/sessions/notes.jsonl`,
      codexHome: MANAGED_HOME
    }
    const claude = { agent: 'claude', path: REAL_HOME_ROLLOUT, codexHome: null }
    expect(dedupeCodexRolloutFileAliases([real, other, oddName, claude], accessors)).toEqual([
      real,
      other,
      oddName,
      claude
    ])
  })

  it('keeps same-name files unless a shared hardlink identity proves they alias', () => {
    const real = {
      agent: 'codex',
      path: REAL_HOME_ROLLOUT,
      codexHome: null,
      hardlinkIdentity: '1:10'
    }
    const differentFile = {
      agent: 'codex',
      path: MANAGED_HOME_ROLLOUT,
      codexHome: MANAGED_HOME,
      hardlinkIdentity: '1:11'
    }
    const unprovenCopy = {
      agent: 'codex',
      path: MANAGED_HOME_ROLLOUT,
      codexHome: MANAGED_HOME
    }

    expect(dedupeCodexRolloutFileAliases([real, differentFile], accessors)).toEqual([
      real,
      differentFile
    ])
    expect(dedupeCodexRolloutFileAliases([real, unprovenCopy], accessors)).toEqual([
      real,
      unprovenCopy
    ])
  })

  it('never treats matching host and WSL inode tuples as one hardlink', () => {
    const rolloutName = REAL_HOME_ROLLOUT.split('/').at(-1)
    const host = {
      agent: 'codex',
      path: `C:\\Users\\ada\\.codex\\sessions\\${rolloutName}`,
      codexHome: null,
      hardlinkIdentity: '1:42'
    }
    const wsl = {
      agent: 'codex',
      path: `\\\\wsl$\\Ubuntu\\home\\ada\\.codex\\sessions\\${rolloutName}`,
      codexHome: '\\\\wsl$\\Ubuntu\\home\\ada\\.codex',
      hardlinkIdentity: '1:42'
    }

    expect(dedupeCodexRolloutFileAliases([host, wsl], accessors)).toEqual([host, wsl])
  })

  it('prefers a per-account self-contained home over other non-default homes', () => {
    const perAccount = {
      agent: 'codex',
      path: '/Users/ada/Library/Application Support/orca/codex-accounts/019f0000-aaaa-bbbb/home/sessions/2026/07/01/rollout-2026-07-01T10-00-00-019f0000-1111-7222-8333-444444444444.jsonl',
      codexHome:
        '/Users/ada/Library/Application Support/orca/codex-accounts/019f0000-aaaa-bbbb/home',
      hardlinkIdentity: '3:71'
    }
    const custom = {
      agent: 'codex',
      path: '/Users/ada/custom-codex/sessions/2026/07/01/rollout-2026-07-01T10-00-00-019f0000-1111-7222-8333-444444444444.jsonl',
      codexHome: '/Users/ada/custom-codex',
      hardlinkIdentity: '3:71'
    }
    expect(dedupeCodexRolloutFileAliases([custom, perAccount], accessors)).toEqual([perAccount])
    expect(dedupeCodexRolloutFileAliases([perAccount, custom], accessors)).toEqual([perAccount])
  })

  it('keeps the real home over a per-account home when they alias', () => {
    const perAccount = {
      agent: 'codex',
      path: '/Users/ada/Library/Application Support/orca/codex-accounts/019f0000-aaaa-bbbb/home/sessions/2026/07/01/rollout-2026-07-01T10-00-00-019f0000-1111-7222-8333-444444444444.jsonl',
      codexHome:
        '/Users/ada/Library/Application Support/orca/codex-accounts/019f0000-aaaa-bbbb/home',
      hardlinkIdentity: '1:42'
    }
    const real = {
      agent: 'codex',
      path: REAL_HOME_ROLLOUT,
      codexHome: null,
      hardlinkIdentity: '1:42'
    }
    expect(dedupeCodexRolloutFileAliases([perAccount, real], accessors)).toEqual([real])
  })
})

describe('dedupeCodexSessionsBySessionId', () => {
  it('collapses a both-roots session to the real-home row', () => {
    const managed = codexSession({
      filePath: MANAGED_HOME_ROLLOUT,
      codexHome: MANAGED_HOME,
      id: `local:codex:session-1:${MANAGED_HOME_ROLLOUT}`
    })
    const real = codexSession({
      filePath: REAL_HOME_ROLLOUT,
      codexHome: null,
      id: `local:codex:session-1:${REAL_HOME_ROLLOUT}`
    })
    expect(dedupeCodexSessionsBySessionId([managed, real])).toEqual([real])
    expect(dedupeCodexSessionsBySessionId([real, managed])).toEqual([real])
  })

  it('keeps managed-only and real-only sessions unchanged', () => {
    const managedOnly = codexSession({
      sessionId: 'managed-only',
      filePath: `${MANAGED_HOME}/sessions/2026/07/01/rollout-a.jsonl`,
      codexHome: MANAGED_HOME
    })
    const realOnly = codexSession({
      sessionId: 'real-only',
      filePath: REAL_HOME_ROLLOUT,
      codexHome: null
    })
    expect(dedupeCodexSessionsBySessionId([managedOnly, realOnly])).toEqual([managedOnly, realOnly])
  })

  it('never collapses across execution hosts or agents', () => {
    const local = codexSession({
      sessionId: 'session-1',
      executionHostId: 'local',
      filePath: '/home/ada/.codex/sessions/rollout-shared.jsonl'
    })
    const remote = codexSession({
      sessionId: 'session-1',
      executionHostId: 'ssh:build-box',
      filePath: '/home/ada/.codex/sessions/rollout-shared.jsonl',
      id: 'ssh:build-box:codex:session-1:/home/ada/.codex/sessions/x.jsonl'
    })
    const claude = codexSession({
      sessionId: 'session-1',
      agent: 'claude',
      filePath: '/home/ada/.codex/sessions/rollout-shared.jsonl'
    })
    expect(dedupeCodexSessionsBySessionId([local, remote, claude])).toEqual([local, remote, claude])
  })

  it('preserves same-host session-id collisions when rollout file names differ', () => {
    const older = codexSession({
      sessionId: 'collision',
      filePath: '/Users/ada/.codex/sessions/2026/07/01/rollout-old.jsonl',
      codexHome: null,
      updatedAt: '2026-07-01T10:00:00.000Z',
      modifiedAt: '2026-07-01T10:00:00.000Z'
    })
    const newer = codexSession({
      sessionId: 'collision',
      filePath: '/Users/ada/.codex/sessions/2026/07/02/rollout-new.jsonl',
      codexHome: null,
      updatedAt: '2026-07-02T10:00:00.000Z',
      modifiedAt: '2026-07-02T10:00:00.000Z'
    })
    expect(dedupeCodexSessionsBySessionId([older, newer])).toEqual([older, newer])
  })

  it('resolves same-rollout aliases with a stable path tie-break', () => {
    const tieA = codexSession({
      sessionId: 'tie',
      filePath: '/Users/ada/a/.codex/sessions/2026/07/01/rollout-tie.jsonl',
      codexHome: null
    })
    const tieB = codexSession({
      sessionId: 'tie',
      filePath: '/Users/ada/b/.codex/sessions/2026/07/01/rollout-tie.jsonl',
      codexHome: null
    })
    expect(dedupeCodexSessionsBySessionId([tieB, tieA])).toEqual([tieA])
  })

  it('prefers the managed runtime home over a WSL real home when no host real-home row exists', () => {
    const wslManaged = codexSession({
      sessionId: 'wsl-pair',
      filePath:
        '\\\\wsl$\\Ubuntu\\home\\ada\\.local\\share\\orca\\codex-runtime-home\\home\\sessions\\rollout-a.jsonl',
      codexHome: '\\\\wsl$\\Ubuntu\\home\\ada\\.local\\share\\orca\\codex-runtime-home\\home'
    })
    const wslReal = codexSession({
      sessionId: 'wsl-pair',
      filePath: '\\\\wsl$\\Ubuntu\\home\\ada\\.codex\\sessions\\rollout-a.jsonl',
      codexHome: '\\\\wsl$\\Ubuntu\\home\\ada\\.codex'
    })
    expect(dedupeCodexSessionsBySessionId([wslReal, wslManaged])).toEqual([wslManaged])
  })

  it('never collapses matching host and WSL session identities', () => {
    const rolloutName = REAL_HOME_ROLLOUT.split('/').at(-1)
    const host = codexSession({
      sessionId: 'shared-id',
      filePath: `C:\\Users\\ada\\.codex\\sessions\\${rolloutName}`,
      codexHome: null
    })
    const wsl = codexSession({
      sessionId: 'shared-id',
      filePath: `\\\\wsl.localhost\\Ubuntu\\home\\ada\\.local\\share\\orca\\codex-runtime-home\\home\\sessions\\${rolloutName}`,
      codexHome:
        '\\\\wsl.localhost\\Ubuntu\\home\\ada\\.local\\share\\orca\\codex-runtime-home\\home'
    })

    expect(dedupeCodexSessionsBySessionId([host, wsl])).toEqual([host, wsl])
  })
})
