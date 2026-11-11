import { afterEach, describe, expect, it, vi } from 'vitest'
import '../../../../shared/agent-launch/catalog/tui-agent-display-names'
import type { CliWorktreeBuilder } from '../../rpc/methods/agent-launch/agent-launch-cwd-cli.test-fixture'
import '../../../../shared/execution-host'
import { WorktreeCreate } from '../../../../shared/rpc-contract/worktree-create-params'
import { WorktreeCreate as PreObservationCreate } from '../../../../shared/rpc-contract/worktree-create-params.pre-observation.test-fixture'
import { AgentLaunch, AgentLaunchReplay } from '../../../../shared/rpc-contract/agent-launch-params'
import {
  AgentLaunch as PreObservationLaunch,
  AgentLaunchReplay as PreObservationReplay
} from '../../../../shared/rpc-contract/agent-launch-params.pre-observation.test-fixture'
import { RuntimeWorktreeLineageController } from './runtime-worktree-lineage-controller'

import type { ResolvedWorktree } from '../catalog/runtime-worktree-path-identity'
import {
  formatAmbiguousCwdParentMessage,
  type WorktreeLineageInput
} from './runtime-worktree-lineage-resolution'
import {
  makeRuntimeOrchestrationDb,
  taskLineageRow
} from '../../orca-runtime-tests/runtime-orchestration-db.test-fixture'
import { buildManagedWorktreeCreateArgs } from '../../rpc/methods/workspaces/worktree-create-args'
import { mapRuntimeError } from '../../rpc/errors'

const fixturesPath = '../../../../cli/test-fixtures'
const { buildWorktree }: { buildWorktree: CliWorktreeBuilder } = await import(fixturesPath)
const root: Omit<ReturnType<typeof buildWorktree>, 'identity'> = buildWorktree(
  '/tmp/owner-choice',
  'main',
  'abc',
  'repo-a'
)
const siblingId = `${root.id}::workspace:11111111-1111-4111-8111-111111111111`
const choices = [`id:${siblingId}`, `id:${root.id}`]
const unresolved = {
  cwdParentWorktree: choices[0],
  cwdParentAmbiguous: true as const,
  callerTerminalHandle: 'term_R'
}

function worktree(id: string): ResolvedWorktree {
  return {
    ...root,
    ...root.git,
    id,
    hostId: 'local',
    instanceId: id,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0
  }
}

function fixture() {
  const db = makeRuntimeOrchestrationDb()
  const showTerminal = vi.fn(async (_handle: string) => ({ worktreeId: root.id }))
  const resolveWorktree = vi.fn(async (selector: string) => {
    if (selector === 'id:stale') {
      throw new Error('selector_not_found')
    }
    return worktree(selector.replace(/^id:/, ''))
  })
  const controller = new RuntimeWorktreeLineageController({
    getStore: () => null,
    getDb: () => db,
    showTerminal,
    resolveWorkspace: async (selector: string) => ({
      kind: 'worktree' as const,
      worktree: await resolveWorktree(selector)
    })
  })
  return { controller, db, showTerminal, resolveWorktree }
}

function parseVersionedCreate(
  newHost: boolean,
  route: 'create' | 'launch' | 'replay',
  create: Record<string, unknown>
) {
  if (route === 'create') {
    return (newHost ? WorktreeCreate : PreObservationCreate).parse(create)
  }
  const schema =
    route === 'launch'
      ? newHost
        ? AgentLaunch
        : PreObservationLaunch
      : newHost
        ? AgentLaunchReplay
        : PreObservationReplay
  const parsed = schema.parse({
    agent: 'codex',
    operationId: `${Date.now()}-${'a'.repeat(32)}`,
    target: { kind: 'create-worktree', create }
  })
  if (parsed.target.kind !== 'create-worktree') {
    throw new Error('fixture target changed')
  }
  return parsed.target.create
}

afterEach(() => vi.restoreAllMocks())

describe('consumed cwd parent at the production authority boundary', () => {
  it.each(['absent', 'stale-terminal', 'stale-env', 'stale-task', 'terminal-disappears'])(
    'refuses a retained positive cwd tie (%s), preserving exact RPC recovery',
    async (kind) => {
      const { controller, showTerminal, db } = fixture()
      const input: WorktreeLineageInput = { ...unresolved }
      if (kind === 'terminal-disappears') {
        expect(await showTerminal('term_R')).toEqual({ worktreeId: root.id })
        expect(await controller.resolveParent(choices[1]!)).toMatchObject({
          worktree: { id: root.id }
        })
      }
      showTerminal.mockRejectedValue(new Error('terminal_not_found'))
      if (kind === 'absent') {
        delete input.callerTerminalHandle
      }
      if (kind === 'stale-env') {
        input.envParentWorkspace = 'id:stale'
      }
      if (kind === 'stale-task') {
        input.comment = 'created for task_stale'
        vi.spyOn(db, 'getTask').mockReturnValue(
          taskLineageRow({ id: 'task_stale', created_by_terminal_handle: 'term_gone' })
        )
      }
      for (const order of [choices, choices.toReversed()]) {
        let caught: unknown
        try {
          await controller.resolveCreate(
            { ...input, cwdParentWorktree: order[0], cwdParentAmbiguous: true },
            'local'
          )
        } catch (error) {
          caught = error
        }
        expect(caught).toMatchObject({ code: 'LINEAGE_PARENT_AMBIGUOUS' })
        const wire = mapRuntimeError('refusal', { runtimeId: 'runtime-1' }, caught)
        expect(wire).toMatchObject({
          ok: false,
          error: {
            code: 'LINEAGE_PARENT_AMBIGUOUS',
            message: formatAmbiguousCwdParentMessage()
          }
        })
      }
    }
  )

  it.each([false, true])(
    'executes old/new client and host schema compatibility (newClient=%s)',
    async (newClient) => {
      const { controller, showTerminal } = fixture()
      const request = {
        repo: 'id:repo-a',
        name: 'child',
        cwdParentWorktree: choices[0],
        callerTerminalHandle: 'term_R',
        ...(newClient ? { cwdParentAmbiguous: true } : {})
      }
      for (const newHost of [false, true]) {
        for (const route of ['create', 'launch', 'replay'] as const) {
          const parsed = parseVersionedCreate(newHost, route, request)
          const { lineage } = buildManagedWorktreeCreateArgs(parsed, {})
          showTerminal.mockResolvedValue({ worktreeId: root.id })
          expect(await controller.resolveCreate(lineage, 'local')).toMatchObject({
            kind: 'lineage',
            capture: { source: 'terminal-context' },
            parent: { worktree: { id: root.id } }
          })
          showTerminal.mockRejectedValue(new Error('terminal_not_found'))
          if (newHost && newClient) {
            await expect(controller.resolveCreate(lineage, 'local')).rejects.toMatchObject({
              code: 'LINEAGE_PARENT_AMBIGUOUS'
            })
          } else {
            expect(lineage).not.toHaveProperty('cwdParentAmbiguous')
            expect(await controller.resolveCreate(lineage, 'local')).toMatchObject({
              kind: 'lineage',
              capture: { source: 'cwd-context', confidence: 'inferred' },
              parent: { worktree: { id: siblingId } }
            })
          }
        }
      }
    }
  )
})
