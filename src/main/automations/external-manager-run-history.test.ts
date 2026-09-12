import { afterEach, expect, it, vi } from 'vitest'
import { listExternalAutomationRuns } from './external-manager-runs'
import { getActiveMultiplexer } from '../ssh/ssh-target-registry'
import type { ExternalAutomationRunsInput } from '../../shared/automations-types'

vi.mock('../ssh/ssh-target-registry', () => ({ getActiveMultiplexer: vi.fn() }))
const input: ExternalAutomationRunsInput = {
  managerId: 'hermes:ssh:box',
  provider: 'hermes',
  target: { type: 'ssh', connectionId: 'box' },
  jobId: 'job-1',
  page: 1,
  pageSize: 8,
  summaryOnly: true
}
afterEach(() => vi.resetAllMocks())

function relay(request: ReturnType<typeof vi.fn>) {
  vi.mocked(getActiveMultiplexer).mockReturnValue({ request, isDisposed: () => false } as never)
}

it('preserves full output when an older relay declines the opt-in method', async () => {
  const request = vi
    .fn()
    .mockRejectedValueOnce({ code: -32601 })
    .mockResolvedValueOnce({
      total: 1,
      runs: [{ id: 'run-1', output_content: 'legacy full log' }]
    })
  relay(request)
  const result = await listExternalAutomationRuns(input)
  expect(request.mock.calls.map(([method]) => method)).toEqual([
    'externalAutomations.runHistory',
    'externalAutomations.runs'
  ])
  expect(result.runs[0]).toMatchObject({ outputContent: 'legacy full log' })
  expect(result.runs[0].outputContentDeferred).toBeUndefined()
})

it('does not retry transport failures or turn unsupported detail into a different run', async () => {
  const request = vi.fn().mockRejectedValue(new Error('connection lost'))
  relay(request)
  await expect(listExternalAutomationRuns(input)).rejects.toThrow('connection lost')
  expect(request).toHaveBeenCalledTimes(1)
  request.mockReset().mockRejectedValue({ code: -32601 })
  await expect(
    listExternalAutomationRuns({ ...input, summaryOnly: false, runId: 'run-1' })
  ).rejects.toThrow()
  expect(request).toHaveBeenCalledTimes(1)
})

it('maps summary state only when explicitly supplied by the host', async () => {
  const request = vi.fn().mockResolvedValue({
    total: 1,
    runs: [{ id: 'run-1', output_content: null, output_content_deferred: true }]
  })
  relay(request)
  const result = await listExternalAutomationRuns(input)
  expect(result.runs[0]).toMatchObject({ outputContent: null, outputContentDeferred: true })
  expect(request).toHaveBeenCalledWith(
    'externalAutomations.runHistory',
    expect.objectContaining({ summaryOnly: true })
  )
})
