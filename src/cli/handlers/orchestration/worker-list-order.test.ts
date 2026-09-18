import { afterEach, expect, it, vi } from 'vitest'
import type { HandlerContext } from '../../dispatch'
import { parseArgs } from '../../args'
import { ORCHESTRATION_WORKER_COMMAND_SPECS } from '../../specs/orchestration-worker-specs'
import { encodeWorkerListOrderCursor } from '../../../shared/worker-list-order-cursor'
import { ORCHESTRATION_WORKER_TERMINAL_HANDLERS } from './worker-terminal-handlers'

afterEach(() => vi.restoreAllMocks())
async function invoke(call: ReturnType<typeof vi.fn>, flags: [string, string | boolean][]) {
  const logged = vi.spyOn(console, 'log').mockImplementation(() => {})
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Only call is used by this handler; the fake cannot contact a running Orca.
  const client = { call } as unknown as HandlerContext['client']
  await ORCHESTRATION_WORKER_TERMINAL_HANDLERS['orchestration worker-list']({
    flags: new Map([['run', 'run-test'], ...flags]),
    client,
    cwd: '/unused',
    json: true
  })
  return JSON.parse(String(logged.mock.calls[0][0])).result
}
const page = {
  workers: [],
  counts: {},
  page: { limit: 20, total: 0, hasMore: false, nextCursor: null }
}
it('passes desc, scope, filters and page size and prints the confirmed order', async () => {
  const call = vi
    .fn()
    .mockResolvedValue({ result: { ...page, page: { ...page.page, order: 'desc' } } })
  const result = await invoke(call, [
    ['order', 'desc'],
    ['limit', '20'],
    ['terminal-state', 'retained'],
    ['include-remote', true]
  ])
  expect(call).toHaveBeenCalledWith('orchestration.workerList', {
    paginate: true,
    run: 'run-test',
    order: 'desc',
    limit: 20,
    terminalState: 'retained',
    includeRemote: true,
    cursor: undefined
  })
  expect(result.page.order).toBe('desc')
})
it.each([undefined, 'asc'])('rejects a host that fails to confirm desc (%s)', async (order) => {
  const call = vi.fn().mockResolvedValue({ result: { ...page, page: { ...page.page, order } } })
  await expect(invoke(call, [['order', 'desc']])).rejects.toMatchObject({
    code: 'incompatible_runtime'
  })
  expect(console.log).not.toHaveBeenCalled()
})
it('also requires desc confirmation when continuing with only a v4 cursor', async () => {
  const call = vi.fn().mockResolvedValue({ result: page })
  const cursor = encodeWorkerListOrderCursor({ run: 'run-test' }, 'inner-cursor')
  await expect(invoke(call, [['cursor', cursor]])).rejects.toMatchObject({
    code: 'incompatible_runtime'
  })
  expect(console.log).not.toHaveBeenCalled()
})
it('keeps old-host default listing working and rejects invalid orders before calling', async () => {
  const call = vi.fn().mockResolvedValue({ result: page })
  await expect(invoke(call, [])).resolves.toMatchObject(page)
  call.mockClear()
  await expect(invoke(call, [['order', 'newest']])).rejects.toMatchObject({
    code: 'invalid_argument'
  })
  expect(call).not.toHaveBeenCalled()
})
it('exposes order as a value flag in worker-list', () => {
  expect(parseArgs(['orchestration', 'worker-list', '--order', 'desc']).flags.get('order')).toBe(
    'desc'
  )
  expect(
    ORCHESTRATION_WORKER_COMMAND_SPECS.find(
      (spec) => spec.path.join(' ') === 'orchestration worker-list'
    )?.allowedFlags
  ).toContain('order')
})
