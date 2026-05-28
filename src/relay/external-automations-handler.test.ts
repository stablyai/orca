import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ExternalAutomationsHandler } from './external-automations-handler'
import type { RelayDispatcher } from './dispatcher'

const execFileMock = vi.hoisted(() =>
  vi.fn((...args: unknown[]) => {
    const callback = args.at(-1)
    if (typeof callback === 'function') {
      const execCallback = callback as (error: Error | null, stdout: string, stderr: string) => void
      execCallback(null, '', '')
    }
  })
)

vi.mock('child_process', () => ({ execFile: execFileMock }))

type CapturedHandler = (params?: Record<string, unknown>) => Promise<unknown>

function createHandlerHarness(): {
  handler: ExternalAutomationsHandler
  requestHandlers: Map<string, CapturedHandler>
} {
  const requestHandlers = new Map<string, CapturedHandler>()
  const dispatcher = {
    onRequest(method: string, handler: CapturedHandler): void {
      requestHandlers.set(method, handler)
    }
  }
  const handler = new ExternalAutomationsHandler(dispatcher as unknown as RelayDispatcher)
  return { handler, requestHandlers }
}

beforeEach(() => {
  execFileMock.mockClear()
})

describe('ExternalAutomationsHandler', () => {
  it('runs external lifecycle actions without shell wrapping', async () => {
    const { requestHandlers } = createHandlerHarness()

    await requestHandlers.get('externalAutomations.act')?.({
      provider: 'hermes',
      action: 'run',
      jobId: 'job-1'
    })

    expect(execFileMock).toHaveBeenCalledWith(
      'hermes',
      ['cron', 'run', 'job-1'],
      { encoding: 'utf-8', timeout: 30_000 },
      expect.any(Function)
    )
  })

  it('paginates remote Hermes run history after ref lookup', async () => {
    const { handler, requestHandlers } = createHandlerHarness()
    const handlerInternals = handler as unknown as {
      readHermesRunRefs: (jobId: string) => Promise<{ id: string; run_at: string }[]>
      hydrateHermesRunRef: (
        jobId: string,
        ref: { id: string; run_at: string }
      ) => Promise<{ id: string; run_at: string }>
    }
    handlerInternals.readHermesRunRefs = vi.fn().mockResolvedValue([
      {
        id: 'cron_job-1_20260516_090000',
        run_at: '2026-05-16T09:00:00'
      },
      {
        id: 'job-1:2026-05-15_09-00-00.md',
        run_at: '2026-05-15T09:00:00'
      },
      {
        id: 'job-1:2026-05-14_09-00-00.md',
        run_at: '2026-05-14T09:00:00'
      }
    ])
    handlerInternals.hydrateHermesRunRef = vi.fn(async (_jobId, ref) => ref)

    const result = (await requestHandlers.get('externalAutomations.runs')?.({
      provider: 'hermes',
      jobId: 'job-1',
      page: 1,
      pageSize: 2
    })) as { total: number; runs: { id: string }[] }

    expect(result.total).toBe(3)
    expect(result.runs.map((run) => run.id)).toEqual([
      'cron_job-1_20260516_090000',
      'job-1:2026-05-15_09-00-00.md'
    ])
  })

  it('uses a count-only path for remote Hermes manager listing run counts', async () => {
    const { handler, requestHandlers } = createHandlerHarness()
    const handlerInternals = handler as unknown as {
      readHermesRunCount: (jobId: string) => Promise<number>
    }
    handlerInternals.readHermesRunCount = vi.fn().mockResolvedValue(42)

    const result = (await requestHandlers.get('externalAutomations.runs')?.({
      provider: 'hermes',
      jobId: 'job-1',
      page: 1,
      pageSize: 0
    })) as { total: number; runs: unknown[] }

    expect(result).toEqual({ total: 42, runs: [] })
  })

  it('deduplicates concurrent remote Hermes count reads', async () => {
    const { handler, requestHandlers } = createHandlerHarness()
    let resolveRefs: (refs: { id: string; run_at: string }[]) => void = () => {}
    const readHermesRunRefs = vi.fn(
      () =>
        new Promise<{ id: string; run_at: string }[]>((resolve) => {
          resolveRefs = resolve
        })
    )
    const handlerInternals = handler as unknown as {
      readHermesRunRefs: typeof readHermesRunRefs
    }
    handlerInternals.readHermesRunRefs = readHermesRunRefs

    const first = requestHandlers.get('externalAutomations.runs')?.({
      provider: 'hermes',
      jobId: 'job-1',
      page: 1,
      pageSize: 0
    })
    const second = requestHandlers.get('externalAutomations.runs')?.({
      provider: 'hermes',
      jobId: 'job-1',
      page: 1,
      pageSize: 0
    })

    expect(readHermesRunRefs).toHaveBeenCalledTimes(1)
    resolveRefs([
      { id: 'job-1:2026-05-15_09-00-00.md', run_at: '2026-05-15T09:00:00' },
      { id: 'job-1:2026-05-16_09-00-00.md', run_at: '2026-05-16T09:00:00' }
    ])

    await expect(Promise.all([first, second])).resolves.toEqual([
      { total: 2, runs: [] },
      { total: 2, runs: [] }
    ])
  })

  it('clears the remote Hermes count cache after lifecycle actions', async () => {
    const { handler, requestHandlers } = createHandlerHarness()
    const readHermesRunRefs = vi
      .fn()
      .mockResolvedValueOnce([
        { id: 'job-1:2026-05-15_09-00-00.md', run_at: '2026-05-15T09:00:00' }
      ])
      .mockResolvedValueOnce([
        { id: 'job-1:2026-05-15_09-00-00.md', run_at: '2026-05-15T09:00:00' },
        { id: 'job-1:2026-05-16_09-00-00.md', run_at: '2026-05-16T09:00:00' }
      ])
    const handlerInternals = handler as unknown as {
      readHermesRunRefs: typeof readHermesRunRefs
    }
    handlerInternals.readHermesRunRefs = readHermesRunRefs

    await expect(
      requestHandlers.get('externalAutomations.runs')?.({
        provider: 'hermes',
        jobId: 'job-1',
        page: 1,
        pageSize: 0
      })
    ).resolves.toEqual({ total: 1, runs: [] })
    await expect(
      requestHandlers.get('externalAutomations.runs')?.({
        provider: 'hermes',
        jobId: 'job-1',
        page: 1,
        pageSize: 0
      })
    ).resolves.toEqual({ total: 1, runs: [] })

    await requestHandlers.get('externalAutomations.act')?.({
      provider: 'hermes',
      action: 'run',
      jobId: 'job-1'
    })
    await expect(
      requestHandlers.get('externalAutomations.runs')?.({
        provider: 'hermes',
        jobId: 'job-1',
        page: 1,
        pageSize: 0
      })
    ).resolves.toEqual({ total: 2, runs: [] })
    expect(readHermesRunRefs).toHaveBeenCalledTimes(2)
  })
})
