import { makePaneKey } from '../../shared/stable-pane-id'
import type { AgentHookServer } from './server'

export const LEAF_1 = '11111111-1111-4111-8111-111111111111'
export const LEAF_2 = '22222222-2222-4222-8222-222222222222'
export const LEAF_3 = '33333333-3333-4333-8333-333333333333'
export const LEAF_4 = '44444444-4444-4444-8444-444444444444'
export const LEAF_5 = '55555555-5555-4555-8555-555555555555'
export const PANE = makePaneKey('tab-1', LEAF_1)
export const GOOD_PANE = makePaneKey('tab-good', LEAF_2)
export const OLD_PANE = makePaneKey('tab-old', LEAF_3)
export const FRESH_PANE = makePaneKey('tab-fresh', LEAF_4)
export const TAB_A_PANE = makePaneKey('tab-A', LEAF_5)
export const RUNNING_SHELL = { id: 'shell-1', type: 'shell', status: 'running' }

export type Body = {
  paneKey: string
  launchToken?: string
  tabId?: string
  worktreeId?: string
  env?: string
  version?: string
  payload: Record<string, unknown>
}

export type AgentHookServerCacheInternals = {
  assistantMessageRetryTimers: Map<string, number | ReturnType<typeof globalThis.setTimeout>>
  promptSentDedupeByPaneKey: Map<string, unknown>
  runtimeObservedStatusPaneKeys: Set<string>
  scheduleStatusPersist: () => void
}

export function buildBody(payload: Record<string, unknown>, overrides: Partial<Body> = {}): Body {
  return {
    paneKey: PANE,
    tabId: 'tab-1',
    worktreeId: 'wt-1',
    env: 'production',
    payload,
    ...overrides
  }
}

// Why: use a recent-but-not-now timestamp so fixtures survive hydrate's 7d drop (HYDRATE_MAX_AGE_MS) without racing the wall clock.
export function recentTs(offsetMs = 0): number {
  return Date.now() - 60 * 60 * 1000 + offsetMs
}

export async function postHookEvent(
  server: AgentHookServer,
  body: Body,
  path: string = '/hook/claude'
): Promise<Response> {
  const env = server.buildPtyEnv()
  return fetch(`http://127.0.0.1:${env.ORCA_AGENT_HOOK_PORT}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Orca-Agent-Hook-Token': env.ORCA_AGENT_HOOK_TOKEN
    },
    body: JSON.stringify(body)
  })
}
