import { describe, expect, it } from 'vitest'
import type { RuntimeWorktreeAgentRow } from '../../../src/shared/runtime-types'
import type { ConnectionState } from '../transport/connection/connection-state'
import type { HostWorktreeInfo } from '../worktree/home-worktree-info'
import {
  buildAgentList,
  selectAgentsNeedingYou,
  type AgentListInput,
  type AgentListRow,
  type AgentListSection
} from './agent-list-model'

const NOW = 1_800_000_000_000
const MINUTE = 60_000

function agent(
  paneKey: string,
  state: RuntimeWorktreeAgentRow['state'],
  overrides: Partial<RuntimeWorktreeAgentRow> = {}
): RuntimeWorktreeAgentRow {
  return {
    paneKey,
    parentPaneKey: null,
    state,
    agentType: 'claude',
    prompt: '',
    taskTitle: null,
    displayName: null,
    lastAssistantMessage: null,
    toolName: null,
    toolInput: null,
    interrupted: false,
    stateStartedAt: NOW - MINUTE,
    updatedAt: NOW - MINUTE,
    ...overrides
  }
}

function entries(agents: RuntimeWorktreeAgentRow[]) {
  return agents.map((row) => ({
    worktreeId: 'wt-1',
    workspaceName: 'mobile-tabs',
    repo: 'orca',
    branch: 'main',
    agent: row
  }))
}

function input(
  hosts: Record<string, { state: ConnectionState; info: Partial<HostWorktreeInfo> }>
): AgentListInput {
  return {
    hosts: Object.keys(hosts).map((id) => ({ id })),
    hostStates: Object.fromEntries(Object.entries(hosts).map(([id, host]) => [id, host.state])),
    worktreeInfo: Object.fromEntries(
      Object.entries(hosts).map(([id, host]) => [
        id,
        { hostId: id, totalWorktrees: 1, activeCount: 0, lastActiveWorktree: null, ...host.info }
      ])
    ),
    now: NOW
  }
}

const panes = (rows: readonly AgentListRow[] | undefined) =>
  rows?.map((row) => row.entry.agent.paneKey)
const shape = (sections: AgentListSection[]) =>
  sections.map((section) => ({
    kind: section.kind,
    rows: panes(section.rows),
    workers: section.rows.map((row) => panes(row.workers)),
    idle: panes(section.idleRows)
  }))
const statusView = (showWorkers: boolean) => ({
  view: { groupBy: 'status' as const, showWorkers },
  hostFilter: null,
  query: ''
})

describe('buildAgentList by status', () => {
  it('buckets agents by what they ask of the user, newest first, and folds idle ones', () => {
    const list = buildAgentList(
      input({
        mac: {
          state: 'connected',
          info: {
            agents: entries([
              agent('asking', 'waiting'),
              agent('older-run', 'working', { stateStartedAt: NOW - 5 * MINUTE }),
              agent('newer-run', 'working', { stateStartedAt: NOW - 2 * MINUTE }),
              agent('finished', 'done'),
              // Silent past the 30-minute freshness window.
              agent('quiet', 'working', { updatedAt: NOW - 31 * MINUTE })
            ])
          }
        }
      }),
      statusView(true)
    )
    expect(shape(list.sections)).toEqual([
      { kind: 'needs-you', rows: ['asking'], workers: [[]], idle: undefined },
      {
        kind: 'working',
        rows: ['newer-run', 'older-run'],
        workers: [[], []],
        idle: undefined
      },
      { kind: 'done', rows: ['finished'], workers: [[]], idle: ['quiet'] }
    ])
  })

  it('nests workers under their coordinator and still lists the one that needs the user', () => {
    const host = input({
      mac: {
        state: 'connected',
        info: {
          agents: entries([
            agent('coordinator', 'working'),
            agent('worker-busy', 'working', { parentPaneKey: 'coordinator' }),
            agent('worker-asking', 'blocked', { parentPaneKey: 'coordinator' })
          ])
        }
      }
    })
    expect(shape(buildAgentList(host, statusView(true)).sections)).toEqual([
      { kind: 'needs-you', rows: ['worker-asking'], workers: [[]], idle: undefined },
      {
        kind: 'working',
        rows: ['coordinator'],
        workers: [['worker-busy', 'worker-asking']],
        idle: undefined
      }
    ])
    expect(shape(buildAgentList(host, statusView(false)).sections)).toEqual([
      { kind: 'needs-you', rows: ['worker-asking'], workers: [[]], idle: undefined },
      { kind: 'working', rows: ['coordinator'], workers: [[]], idle: undefined }
    ])
    expect(panes(selectAgentsNeedingYou(host))).toEqual(['worker-asking'])
  })

  it('keeps a lost desktop’s agents as last seen, outside the status groups and the counts', () => {
    const lastSeen = entries([agent('was-asking', 'waiting')])
    const disconnected = input({
      mac: { state: 'connected', info: { agents: entries([agent('asking', 'waiting')]) } },
      studio: { state: 'disconnected', info: { lastSeenAgents: lastSeen, countsProvenAt: NOW } }
    })
    const list = buildAgentList(disconnected, statusView(true))
    expect(shape(list.sections)).toEqual([
      { kind: 'needs-you', rows: ['asking'], workers: [[]], idle: undefined },
      { kind: 'desktop', rows: ['was-asking'], workers: [[]], idle: undefined }
    ])
    expect(list.sections[1]).toMatchObject({
      hostId: 'studio',
      lastSeen: { offline: true, at: NOW }
    })
    expect(list.sections[1].rows[0]).toMatchObject({ stale: true, offline: true, dotState: 'idle' })
    expect(panes(selectAgentsNeedingYou(disconnected))).toEqual(['asking'])

    // Reconnected, but until its own read lands the old rows still claim nothing.
    const reconnected = input({
      studio: { state: 'connected', info: { lastSeenAgents: lastSeen, countsProvenAt: NOW } }
    })
    expect(selectAgentsNeedingYou(reconnected)).toEqual([])
    expect(buildAgentList(reconnected, statusView(true)).sections[0].rows[0]).toMatchObject({
      stale: true,
      offline: false
    })
  })
})
