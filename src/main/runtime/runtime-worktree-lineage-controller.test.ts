import { afterEach, describe, expect, it, vi } from 'vitest'
import { ALL_TUI_AGENTS } from '../../shared/tui-agent-display-names'
import type { CliWorktreeBuilder } from './rpc/methods/agent-launch-cwd-cli.test-fixture'
import { toSshExecutionHostId } from '../../shared/execution-host'
import { WorktreeCreate } from '../../shared/rpc-contract/worktree-create-params'
import { WorktreeCreate as PreObservationCreate } from '../../shared/rpc-contract/worktree-create-params.pre-observation.test-fixture'
import { AgentLaunch, AgentLaunchReplay } from '../../shared/rpc-contract/agent-launch-params'
import {
  AgentLaunch as PreObservationLaunch,
  AgentLaunchReplay as PreObservationReplay
} from '../../shared/rpc-contract/agent-launch-params.pre-observation.test-fixture'
import { RuntimeWorktreeLineageController } from './runtime-worktree-lineage-controller'
import type { ResolvedWorktree } from './runtime-worktree-path-identity'
import {
  formatAmbiguousCwdParentMessage,
  type WorktreeLineageInput
} from './runtime-worktree-lineage-resolution'
import { makeRuntimeOrchestrationDb, taskLineageRow } from './runtime-orchestration-db.test-fixture'
import { buildManagedWorktreeCreateArgs } from './rpc/methods/worktree-create-args'
import { mapRuntimeError } from './rpc/errors'

const fixturesPath = '../../cli/test-fixtures'
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
    resolveWorktree,
    listResolvedWorktrees: async () => []
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
  it.each(['terminal', 'env', 'task', 'conflict', 'cross-host', 'exact', 'no-parent'] as const)(
    'preserves %s authority/provenance and warnings when choices are unused',
    async (kind) => {
      const { controller, db, showTerminal, resolveWorktree } = fixture()
      const input: WorktreeLineageInput = { ...unresolved }
      if (kind === 'env') {
        input.envParentWorkspace = 'id:outside-cwd'
      }
      if (kind === 'task') {
        input.comment = 'created for task_creator'
        vi.spyOn(db, 'getDispatchContext').mockReturnValue(undefined)
        vi.spyOn(db, 'getTask').mockReturnValue(
          taskLineageRow({ id: 'task_creator', created_by_terminal_handle: 'term_creator' })
        )
        showTerminal.mockImplementation(async (handle) => {
          if (handle !== 'term_creator') {
            throw new Error('terminal_not_found')
          }
          return { worktreeId: root.id }
        })
      } else if (kind !== 'terminal' && kind !== 'conflict') {
        showTerminal.mockRejectedValue(new Error('terminal_not_found'))
      }
      if (kind === 'conflict') {
        input.envParentWorkspace = choices[0]
      }
      if (kind === 'cross-host') {
        resolveWorktree.mockImplementation(async (selector) => ({
          ...worktree(selector.slice(3)),
          hostId: toSshExecutionHostId('other')
        }))
      }
      if (kind === 'exact') {
        input.parentWorktree = choices[1]
      }
      if (kind === 'no-parent') {
        input.noParent = true
      }
      const withoutChoices = { ...input, cwdParentAmbiguous: undefined }
      const before = await controller.resolveCreate(withoutChoices, 'local')
      const after = await controller.resolveCreate(input, 'local')
      expect(after).toEqual(before)
      if (kind === 'conflict' || kind === 'cross-host') {
        expect(after).toMatchObject({
          kind: 'none',
          warnings: [{ code: 'LINEAGE_PARENT_CONTEXT_CONFLICT' }]
        })
      } else if (kind === 'no-parent') {
        expect(after).toEqual({ kind: 'none', warnings: [] })
      } else {
        const source =
          kind === 'env'
            ? 'env-workspace'
            : kind === 'task'
              ? 'orchestration-context'
              : kind === 'exact'
                ? 'explicit-cli-flag'
                : 'terminal-context'
        expect(after).toMatchObject({
          kind: 'lineage',
          origin: kind === 'task' ? 'orchestration' : 'cli',
          capture: { source, confidence: kind === 'exact' ? 'explicit' : 'inferred' },
          parent: { worktree: { id: kind === 'env' ? 'outside-cwd' : root.id } }
        })
        if (kind === 'terminal') {
          expect(after).toHaveProperty('createdByTerminalHandle', 'term_R')
        }
        if (kind === 'task') {
          expect(after).toHaveProperty('taskId', 'task_creator')
        }
      }
    }
  )

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

  it('retains unique/legacy cwd and missing-parent behavior without inventing authority', async () => {
    const { controller, showTerminal } = fixture()
    showTerminal.mockRejectedValue(new Error('terminal_not_found'))
    for (const cwdParentAmbiguous of [undefined]) {
      expect(
        await controller.resolveCreate({ ...unresolved, cwdParentAmbiguous }, 'local')
      ).toMatchObject({
        kind: 'lineage',
        origin: 'cli',
        capture: { source: 'cwd-context', confidence: 'inferred' },
        parent: { worktree: { id: siblingId } }
      })
    }
    expect(
      await controller.resolveCreate({ ...unresolved, cwdParentWorktree: 'id:stale' }, 'local')
    ).toMatchObject({
      kind: 'none',
      warnings: expect.arrayContaining([
        expect.objectContaining({ code: 'LINEAGE_PARENT_CONTEXT_MISSING' })
      ])
    })
  })

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
  it('retains complete historical transforms, refinements and actual launch embeddings', () => {
    for (const newHost of [false, true]) {
      for (const route of ['create', 'launch', 'replay'] as const) {
        for (const value of [undefined, true, false, null, 'true', 1, [], {}]) {
          const request = { repo: 'id:repo-a', cwdParentAmbiguous: value, futureField: 1 }
          if (newHost && value !== undefined && value !== true) {
            expect(() => parseVersionedCreate(newHost, route, request)).toThrow()
          } else {
            const parsed = parseVersionedCreate(newHost, route, request)
            expect(parsed).not.toHaveProperty('futureField')
            expect('cwdParentAmbiguous' in parsed ? parsed.cwdParentAmbiguous : undefined).toBe(
              newHost ? value : undefined
            )
          }
        }
        for (const invalid of [
          { repo: 123 },
          { parentWorktree: 'id:p', noParent: true },
          { parentWorkspace: 'folder:p', noParent: true },
          { parentWorkspace: 'folder:p', parentWorktree: 'id:p' },
          { startupPrompt: 'hello' },
          { linkedWorkItem: { invalid: true }, linkedTaskSourceContext: { invalid: true } }
        ]) {
          expect(() =>
            parseVersionedCreate(newHost, route, { repo: 'id:repo-a', ...invalid })
          ).toThrow()
        }
        const linkedWorkItem = {
          provider: 'github',
          type: 'issue',
          number: 1,
          title: 'Issue',
          url: 'https://github.com/example/repo/issues/1'
        }
        const linkedTaskSourceContext = {
          provider: 'github',
          projectId: 'project',
          hostId: 'local'
        }
        expect(
          parseVersionedCreate(newHost, route, {
            repo: 'id:repo-a',
            linkedWorkItem,
            linkedTaskSourceContext
          })
        ).toMatchObject({ linkedWorkItem, linkedTaskSourceContext })
        expect(() =>
          parseVersionedCreate(newHost, route, {
            repo: 'id:repo-a',
            linkedWorkItem,
            linkedTaskSourceContext: { ...linkedTaskSourceContext, provider: 'gitlab' }
          })
        ).toThrow('Linked work item and source context identities must match')
        expect(
          parseVersionedCreate(newHost, route, {
            repo: 'id:repo-a',
            setupDecision: 'unknown',
            telemetrySource: 'invalid-telemetry-source',
            createdWithAgent: 'unknown',
            startupAgent: 'codex',
            startupPrompt: 'hello'
          })
        ).toMatchObject({
          repo: 'id:repo-a',
          setupDecision: undefined,
          telemetrySource: undefined,
          createdWithAgent: undefined,
          startupAgent: 'codex',
          startupPrompt: 'hello'
        })
        expect(
          parseVersionedCreate(newHost, route, {
            repo: 'id:repo-a',
            telemetrySource: 'unknown'
          })
        ).toMatchObject({ repo: 'id:repo-a', telemetrySource: 'unknown' })
      }
    }
    for (const schema of [
      PreObservationLaunch,
      PreObservationReplay,
      AgentLaunch,
      AgentLaunchReplay
    ]) {
      expect(
        schema.safeParse({
          agent: 'codex',
          operationId: 'malformed',
          target: { kind: 'existing', worktree: 'id:r' }
        }).success
      ).toBe(false)
      expect(() =>
        schema.parse({
          agent: 'codex',
          operationId: `${Date.now()}-${'a'.repeat(32)}`,
          sessionId: 'claude_session',
          target: { kind: 'existing', worktree: 'id:r' }
        })
      ).toThrow('Launch session id must be named for its agent')
    }
    expect(
      PreObservationReplay.safeParse({
        agent: 'codex',
        target: { kind: 'existing', worktree: 'id:r' }
      }).success
    ).toBe(false)
  })
  it.each([false, null, 'true', 1, [], {}])(
    'rejects malformed positive literal %j before runtime reads',
    (value) => {
      const { resolveWorktree, showTerminal } = fixture()
      expect(
        WorktreeCreate.safeParse({ repo: 'id:repo-a', name: 'child', cwdParentAmbiguous: value })
          .success
      ).toBe(false)
      expect(resolveWorktree).not.toHaveBeenCalled()
      expect(showTerminal).not.toHaveBeenCalled()
    }
  )
  it('does not recheck terminal liveness after its existing validation read', async () => {
    const { controller, showTerminal } = fixture()
    showTerminal.mockImplementationOnce(async () => {
      showTerminal.mockRejectedValue(new Error('terminal_not_found'))
      return { worktreeId: root.id }
    })
    expect(await controller.resolveCreate(unresolved, 'local')).toMatchObject({
      capture: { source: 'terminal-context' },
      createdByTerminalHandle: 'term_R'
    })
    expect(showTerminal).toHaveBeenCalledTimes(1)
  })
  it('keeps the complete original refusal bounded for plain creation and every finite agent', () => {
    const codex = [
      'Orca did not create the workspace or start codex because more than one workspace matched the current directory when this request was prepared.',
      'Run `orca worktree list --limit 10000 --json` with the same server and host selection. Match path and host; if truncated, repeat with a larger --limit using totalCount. Choose id:<id> (or identity:<identity.key> for a shared ID), then add --parent-worktree <selector> to your original invocation, or deliberately use --no-parent. Pass the selector as one argument quoted for your shell.',
      'To choose a parent, start a fresh request without --retry-launch; retrying the old ID returns this refusal.'
    ].join('\n')
    expect(formatAmbiguousCwdParentMessage('codex')).toBe(codex)
    expect(formatAmbiguousCwdParentMessage()).toBe(codex.replace(' or start codex', ''))
    expect(formatAmbiguousCwdParentMessage()).toHaveLength(622)
    expect(
      Math.max(...ALL_TUI_AGENTS.map((agent) => formatAmbiguousCwdParentMessage(agent).length))
    ).toBe(650)
    for (const agent of ALL_TUI_AGENTS) {
      expect(formatAmbiguousCwdParentMessage(agent)).toBe(
        codex.replace('or start codex', `or start ${agent}`)
      )
      expect(formatAmbiguousCwdParentMessage(agent).length).toBeLessThan(4224)
    }
  })
})
