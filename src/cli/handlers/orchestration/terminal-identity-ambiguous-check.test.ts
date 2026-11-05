import { afterEach, expect, it, vi } from 'vitest'
import { createOrchestrationRpcHarness } from '../../../main/runtime/rpc/methods/orchestration/rpc-test-harness'
import { RuntimeClient, RuntimeClientError } from '../../runtime-client'
import { okFixture } from '../../test-fixtures'
import { ORCHESTRATION_CHECK_HANDLER } from './message-check-handler'

const h = createOrchestrationRpcHarness()

afterEach(() => {
  h.cleanup()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

it('checks its own Run with A identity but refuses ambiguous identity before choosing coordinator B', async () => {
  const { db, runtime, ctx, activeRunId } = h.setup()
  const runA = activeRunId!
  const paneB = 'tab_other:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
  const runB = db.createRun({
    objective: 'B',
    coordinatorHandle: 'term_other',
    coordinatorPaneKey: paneB
  })
  db.insertMessage({ from: 'worker_a', to: `run:${runA}`, runId: runA, subject: 'A report' })
  db.insertMessage({ from: 'worker_b', to: `run:${runB.id}`, runId: runB.id, subject: 'B report' })
  const beforeA = db.getRun(runA)
  const beforeB = db.getRun(runB.id)
  vi.mocked(runtime.getTerminalPaneKey).mockImplementation((handle) =>
    handle === 'term_coord' ? h.coordinatorPaneKey : handle === 'term_other' ? paneB : null
  )
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: resolveActiveTerminal only reads tabs and the supplied terminal selection fields.
  vi.spyOn(runtime, 'listAllMobileSessionTabs').mockResolvedValue([
    { tabs: [{ type: 'terminal', isActive: true, status: 'ready', terminal: 'term_other' }] }
  ] as never)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: resolveActiveTerminal only reads terminals.length and terminal handles from this fixture.
  vi.spyOn(runtime, 'listTerminals').mockResolvedValue({
    terminals: [{ handle: 'term_coord' }, { handle: 'term_other' }]
  } as never)
  expect(await runtime.resolveActiveTerminal()).toBe('term_other')

  const client = new RuntimeClient('/tmp/orca-ambiguous-check', 60_000, null, null)
  vi.spyOn(client, 'call').mockImplementation(async (method, params) => {
    if (method === 'worktree.list') {
      return okFixture('req_list', { worktrees: [] })
    }
    if (method === 'terminal.resolveActive') {
      try {
        const handle = await runtime.resolveActiveTerminal(
          undefined,
          // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: getTerminalHandle supplies an object whose requireUnambiguous field is boolean when present.
          params as { requireUnambiguous?: boolean }
        )
        return okFixture('req_active', { handle })
      } catch (error) {
        if (error instanceof Error && error.message === 'no_active_terminal') {
          throw new RuntimeClientError('no_active_terminal', error.message)
        }
        throw error
      }
    }
    if (method === 'orchestration.check') {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the check handler supplies an object, and h.call validates its fields with the RPC schema.
      return okFixture('req_check', await h.call(method, params as Record<string, unknown>, ctx))
    }
    throw new Error(`Unexpected RPC: ${method}`)
  })
  const logs = vi.spyOn(console, 'log').mockImplementation(() => {})
  const check = () =>
    ORCHESTRATION_CHECK_HANDLER['orchestration check']({
      flags: new Map<string, string | boolean>([
        ['run', runA],
        ['full', true]
      ]),
      client,
      cwd: '/tmp/repo',
      json: true
    })
  vi.stubEnv('ORCA_AGENT_SESSION_ID', undefined)
  vi.stubEnv('ORCA_STRUCTURED_SESSION', '')
  vi.stubEnv('ORCA_TERMINAL_HANDLE', 'term_coord')
  vi.stubEnv('ORCA_PANE_KEY', h.coordinatorPaneKey)
  await check()
  expect(JSON.parse(String(logs.mock.calls.at(-1)?.[0]))).toMatchObject({
    result: { runId: runA, count: 1, messages: [{ subject: 'A report' }] }
  })

  vi.stubEnv('ORCA_TERMINAL_HANDLE', '')
  vi.stubEnv('ORCA_PANE_KEY', '')
  const refusal = await check().catch((error: unknown) => error)
  expect(db.getRun(runA)).toEqual(beforeA)
  expect(db.getRun(runB.id)).toEqual(beforeB)
  expect(db.hasOutstandingRunDelivery(runB.id)).toBe(false)
  expect(refusal).toMatchObject({ code: 'no_active_terminal' })
})
