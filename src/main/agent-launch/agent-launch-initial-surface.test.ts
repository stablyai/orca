import { describe, expect, it, vi } from 'vitest'
import { executeAgentLaunch, type AgentLaunchExecution } from './agent-launch-executor'
import {
  AgentLaunchStructuredSessionRefusedError,
  type AgentLaunchSurfaceFactory
} from './agent-launch-surface-factories'
import { readCreatedWorkspaceLaunch } from './agent-launch-created-workspace'
import { startRuntimeLocalWorktreeTerminals } from '../runtime/runtime-local-worktree-terminal-startup'
import type { Worktree } from '../../shared/worktree/types'

const worktree: Worktree = {
  id: 'repo::/task',
  repoId: 'repo',
  path: '/task',
  head: 'abc',
  branch: 'task',
  isBare: false,
  isMainWorktree: false,
  displayName: 'task',
  comment: '',
  linkedIssue: null,
  linkedPR: null,
  linkedLinearIssue: null,
  isArchived: false,
  isUnread: false,
  isPinned: false,
  sortOrder: 0,
  lastActivityAt: 1
}

it.each(['chat', 'startup', 'refusal', 'recovery'] as const)(
  'commits the actual %s surface before setup/default provisioning',
  async (outcome) => {
    const events: string[] = []
    let selected: string | null = null
    let wrappedSetup: string | undefined
    const runtime = {
      requireStore: () => ({ getSettings: () => ({ experimentalNativeChat: true }) }),
      getStructuredAgentSessionCreateSupport: async () => ({ supported: true })
    }
    const published = vi.fn<NonNullable<AgentLaunchExecution['onSurfacePublished']>>((surface) => {
      selected = surface.outcome.handle
      events.push('committed')
    })
    const terminalSurface = vi.fn<AgentLaunchSurfaceFactory['createTerminalAgent']>(
      async (args) => {
        const sequenced = args.sequenceTerminalCommand?.('claude')
        if (sequenced) {
          expect(sequenced.command).not.toBe('claude')
        }
        events.push('terminal')
        return { handle: 'actual-terminal' }
      }
    )
    const result = await executeAgentLaunch({
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this contract invokes only settings and structured support on the runtime stub.
      runtime: runtime as unknown as AgentLaunchExecution['runtime'],
      intent: {
        agent: 'claude',
        target: { kind: 'create-worktree', create: {} },
        ...(outcome === 'startup' || outcome === 'recovery' ? { surface: 'terminal' as const } : {})
      },
      onSurfacePublished: published,
      workspaces: {
        createWorktree: async ({ initializeSurface, onWorkspaceCreated, promisedAgentChat }) => {
          onWorkspaceCreated?.(worktree.id)
          expect(readCreatedWorkspaceLaunch(runtime, worktree.id)).toBeDefined()
          const startup = await startRuntimeLocalWorktreeTerminals({
            request: {
              repoSelector: 'repo',
              name: 'task',
              awaitTerminalProvisioning: true,
              initializeSurface
            },
            repo: {
              id: 'repo',
              path: '/repo',
              displayName: 'repo',
              badgeColor: 'blue',
              addedAt: 1
            },
            worktree,
            promisedAgentChat,
            createdWithAgent: 'claude',
            ...(outcome === 'startup' || outcome === 'recovery'
              ? { startup: { command: 'claude' } }
              : {}),
            setup: { runnerScriptPath: '/task/setup.sh', envVars: {}, waitForAgentStartup: true },
            defaultTabs: { tabs: [{ title: 'Default' }], runCommands: false },
            ports: {
              canSpawn: true,
              createTerminal: async (_selector, opts) => {
                if (outcome === 'recovery') {
                  throw new Error('startup unavailable')
                }
                expect(opts.command).not.toBe('claude')
                events.push('startup')
                return { handle: 'startup-terminal', worktreeId: worktree.id, title: null }
              },
              pasteDraft: vi.fn(),
              sendFollowup: vi.fn(),
              activate: vi.fn(),
              provision: async (args) => {
                expect(selected).toBe(
                  outcome === 'chat'
                    ? 'chat'
                    : outcome === 'startup'
                      ? 'startup-terminal'
                      : 'actual-terminal'
                )
                expect(readCreatedWorkspaceLaunch(runtime, worktree.id)).toBeUndefined()
                wrappedSetup = args.wrappedSetupCommand
                events.push('ancillary')
                return { setupSpawned: true, setupTerminalHandle: 'setup' }
              }
            }
          })
          return {
            worktreeId: worktree.id,
            startupTerminalHandle: startup.startupTerminalHandle ?? undefined
          }
        }
      },
      surfaces: {
        createStructuredSession: async () => {
          if (outcome === 'refusal') {
            throw new AgentLaunchStructuredSessionRefusedError(
              'structured_agent_session_unsupported',
              'Unavailable'
            )
          }
          events.push('chat')
          return { sessionId: 'chat', handle: 'chat', fence: 1 }
        },
        createTerminalAgent: terminalSurface
      }
    })
    expect(published).toHaveBeenCalledTimes(1)
    expect(events.indexOf('committed')).toBeLessThan(events.indexOf('ancillary'))
    expect(result.outcome.kind).toBe(outcome === 'chat' ? 'structured' : 'terminal')
    expect(terminalSurface).toHaveBeenCalledTimes(
      outcome === 'refusal' || outcome === 'recovery' ? 1 : 0
    )
    if (outcome !== 'chat') {
      expect(wrappedSetup).toBeDefined()
    }
    expect(readCreatedWorkspaceLaunch(runtime, worktree.id)).toBeUndefined()
  }
)

describe('failed initial surface', () => {
  it('runs ancillary cleanup and releases the live operation without reporting success', async () => {
    const events: string[] = []
    const failure = new Error('uncertain chat create')
    await expect(
      startRuntimeLocalWorktreeTerminals({
        request: {
          repoSelector: 'repo',
          name: 'task',
          awaitTerminalProvisioning: true,
          initializeSurface: async () => {
            events.push('surface')
            throw failure
          }
        },
        repo: { id: 'repo', path: '/repo', displayName: 'repo', badgeColor: 'blue', addedAt: 1 },
        worktree,
        promisedAgentChat: true,
        setup: { runnerScriptPath: '/task/setup.sh', envVars: {} },
        ports: {
          canSpawn: true,
          createTerminal: vi.fn(),
          pasteDraft: vi.fn(),
          sendFollowup: vi.fn(),
          activate: vi.fn(),
          provision: async () => {
            events.push('ancillary')
            return { setupSpawned: true, setupTerminalHandle: 'setup' }
          }
        }
      })
    ).rejects.toBe(failure)
    expect(events).toEqual(['surface', 'ancillary'])
  })
})
