import { describe, expect, it } from 'vitest'
import {
  resolveMobileNativeChatRecoveredSession,
  type MobileNativeChatRecoveryCandidate,
  type MobileNativeChatRecoveryTab
} from './mobile-native-chat-session-recovery'

const NOW = Date.parse('2026-08-27T14:20:00.000Z')
const CWD = '/repo/angelshark'

function candidate(
  overrides: Partial<MobileNativeChatRecoveryCandidate> = {}
): MobileNativeChatRecoveryCandidate {
  return {
    agent: 'claude',
    sessionId: 'sess-live',
    filePath: '/home/u/.claude/projects/angelshark/sess-live.jsonl',
    cwd: CWD,
    modifiedAt: '2026-08-27T14:19:30.000Z',
    isSubagent: false,
    ...overrides
  }
}

function resolve(args: {
  tabs: readonly MobileNativeChatRecoveryTab[]
  candidates: readonly MobileNativeChatRecoveryCandidate[]
  cwd?: string | null
}): { sessionId: string; transcriptPath: string } | null {
  return resolveMobileNativeChatRecoveredSession({
    tabId: 'tab-1',
    agent: 'claude',
    cwd: args.cwd === undefined ? CWD : args.cwd,
    tabs: args.tabs,
    candidates: args.candidates,
    now: NOW
  })
}

const LONE_UNADDRESSED: readonly MobileNativeChatRecoveryTab[] = [
  { id: 'tab-1', agent: 'claude', sessionId: null },
  { id: 'tab-setup', agent: null, sessionId: null }
]

describe('resolveMobileNativeChatRecoveredSession', () => {
  // The reported failure: the agent was started by hand, so no `providerSession`
  // was ever published, the subscribe effect returned early on the null session
  // id, and the chat pane stayed blank while the terminal showed the whole
  // conversation. The host's own session index still knows the transcript.
  it('adopts the live transcript for a pane whose agent published no session', () => {
    expect(resolve({ tabs: LONE_UNADDRESSED, candidates: [candidate()] })).toEqual({
      sessionId: 'sess-live',
      transcriptPath: '/home/u/.claude/projects/angelshark/sess-live.jsonl'
    })
  })

  it('takes the most recently written transcript when the worktree has history', () => {
    const resolved = resolve({
      tabs: LONE_UNADDRESSED,
      candidates: [
        candidate({
          sessionId: 'sess-old',
          filePath: '/t/old.jsonl',
          modifiedAt: '2026-08-27T14:05:00.000Z'
        }),
        candidate({ sessionId: 'sess-live', filePath: '/t/live.jsonl' })
      ]
    })
    expect(resolved?.sessionId).toBe('sess-live')
  })

  it('refuses when a second pane runs the same agent with no session either', () => {
    // Nothing distinguishes which transcript belongs to which pane, and showing
    // the other agent's conversation is worse than showing none.
    expect(
      resolve({
        tabs: [...LONE_UNADDRESSED, { id: 'tab-2', agent: 'claude', sessionId: null }],
        candidates: [candidate()]
      })
    ).toBeNull()
  })

  it('never adopts a transcript another pane already addresses', () => {
    expect(
      resolve({
        tabs: [...LONE_UNADDRESSED, { id: 'tab-2', agent: 'claude', sessionId: 'sess-live' }],
        candidates: [candidate()]
      })
    ).toBeNull()
  })

  it('ignores a sibling pane running a different agent', () => {
    const resolved = resolve({
      tabs: [...LONE_UNADDRESSED, { id: 'tab-2', agent: 'codex', sessionId: null }],
      candidates: [candidate()]
    })
    expect(resolved?.sessionId).toBe('sess-live')
  })

  it('refuses a transcript from another agent, cwd, or a Task subagent', () => {
    expect(
      resolve({ tabs: LONE_UNADDRESSED, candidates: [candidate({ agent: 'codex' })] })
    ).toBeNull()
    expect(
      resolve({ tabs: LONE_UNADDRESSED, candidates: [candidate({ cwd: '/repo/other' })] })
    ).toBeNull()
    expect(
      resolve({ tabs: LONE_UNADDRESSED, candidates: [candidate({ isSubagent: true })] })
    ).toBeNull()
  })

  it('refuses a transcript too old to belong to a live pane', () => {
    // 31 minutes: past AGENT_STATUS_STALE_AFTER_MS, so it cannot be this pane's.
    expect(
      resolve({
        tabs: LONE_UNADDRESSED,
        candidates: [candidate({ modifiedAt: '2026-08-27T13:49:00.000Z' })]
      })
    ).toBeNull()
  })

  it('refuses an unparseable or missing write timestamp', () => {
    expect(
      resolve({ tabs: LONE_UNADDRESSED, candidates: [candidate({ modifiedAt: 'not-a-date' })] })
    ).toBeNull()
  })

  it('still adopts when the pane cwd is unknown but the agent and recency match', () => {
    const resolved = resolve({ tabs: LONE_UNADDRESSED, candidates: [candidate()], cwd: null })
    expect(resolved?.sessionId).toBe('sess-live')
  })

  it('refuses a candidate with no transcript path to address', () => {
    expect(
      resolve({ tabs: LONE_UNADDRESSED, candidates: [candidate({ filePath: '' })] })
    ).toBeNull()
  })
})
