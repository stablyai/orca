import { afterEach, expect, it, vi } from 'vitest'
import { dispatch } from '../../dispatch/dispatch'
import { RuntimeClient } from '../../runtime/client'

afterEach(() => {
  vi.restoreAllMocks()
})

it('keeps task details in full text output and briefs only the spec', async () => {
  const client = new RuntimeClient('/tmp/orca-unused', 1_000, null, null)
  vi.spyOn(client, 'call').mockResolvedValue({
    id: 'req_tasks',
    ok: true,
    result: {
      count: 1,
      tasks: [
        {
          id: 'task_1',
          status: 'completed',
          task_title: 'Audit',
          spec: `Verify the ledger.\n${'x'.repeat(160)}`,
          result: 'Ledger reconciled.\r\nAll balances matched.\x1b'
        }
      ]
    },
    _meta: { runtimeId: 'rt_test' }
  })
  const log = vi.spyOn(console, 'log').mockImplementation(() => {})
  const flags = new Map<string, string | boolean>([
    ['run', 'run_1'],
    ['full', true]
  ])
  const context = { flags, client, cwd: '/tmp', json: false }

  await dispatch(['orchestration', 'task-list'], context)
  flags.set('brief', true)
  await dispatch(['orchestration', 'task-list'], context)

  expect(log.mock.calls.map(([output]) => output)).toEqual([
    `task_1 [completed] Audit\n  Spec: Verify the ledger.\n    ${'x'.repeat(160)}\n  Result: Ledger reconciled.\n    All balances matched.\\x1b`,
    `task_1 [completed] Audit\n  Spec: Verify the ledger. ${'x'.repeat(140)}…\n  Result: Ledger reconciled.\n    All balances matched.\\x1b`
  ])
})
