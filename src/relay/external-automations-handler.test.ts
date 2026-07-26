import { mkdtemp, rm, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
const tempDirs: string[] = []

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

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
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
      readHermesRunRefs: (jobId: string) => Promise<{
        refs: { id: string; run_at: string }[]
        saturated: boolean
      }>
      hydrateHermesRunRef: (
        jobId: string,
        ref: { id: string; run_at: string }
      ) => Promise<{ id: string; run_at: string }>
    }
    handlerInternals.readHermesRunRefs = vi.fn().mockResolvedValue({
      refs: [
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
      ],
      saturated: false
    })
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

  it('bounds remote hydration concurrency and omits page-wide output overflow', async () => {
    const { handler, requestHandlers } = createHandlerHarness()
    const refs = Array.from({ length: 3 }, (_, index) => ({
      id: `run-${index}`,
      run_at: `2026-05-15T09:00:0${index}`
    }))
    let active = 0
    let maxActive = 0
    const handlerInternals = handler as unknown as {
      readHermesRunRefs: () => Promise<{ refs: typeof refs; saturated: boolean }>
      hydrateHermesRunRef: (
        jobId: string,
        ref: (typeof refs)[number]
      ) => Promise<{ id: string; output_content: string }>
    }
    handlerInternals.readHermesRunRefs = vi.fn().mockResolvedValue({ refs, saturated: false })
    handlerInternals.hydrateHermesRunRef = vi.fn(async (_jobId, ref) => {
      active += 1
      maxActive = Math.max(maxActive, active)
      await new Promise<void>((resolve) => setTimeout(resolve, 1))
      active -= 1
      return { id: ref.id, output_content: 'x'.repeat(16 * 1024 * 1024 + 1) }
    })

    const result = (await requestHandlers.get('externalAutomations.runs')?.({
      provider: 'hermes',
      jobId: 'job-1',
      page: 1,
      pageSize: 3
    })) as {
      runs: { id: string; output_content: string | null; error?: string }[]
    }

    expect(maxActive).toBe(2)
    expect(result.runs.map((run) => run.id)).toEqual(refs.map((ref) => ref.id))
    expect(result.runs[0]?.output_content).toHaveLength(16 * 1024 * 1024 + 1)
    expect(result.runs.slice(1)).toEqual([
      expect.objectContaining({ output_content: null, error: expect.stringContaining('omitted') }),
      expect.objectContaining({ output_content: null, error: expect.stringContaining('omitted') })
    ])
  })

  it('omits an oversized sparse remote markdown output without reading it wholesale', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'orca-relay-hermes-output-'))
    tempDirs.push(tempDir)
    const outputPath = join(tempDir, '2026-05-15_09-00-00.md')
    await writeFile(outputPath, '', 'utf-8')
    await truncate(outputPath, 64 * 1024 * 1024)
    const { handler } = createHandlerHarness()
    const handlerInternals = handler as unknown as {
      readHermesOutputFileRun: (ref: Record<string, unknown>) => Promise<unknown>
    }

    const run = await handlerInternals.readHermesOutputFileRun({
      kind: 'output',
      id: 'job-1:2026-05-15_09-00-00.md',
      job_id: 'job-1',
      run_at: '2026-05-15T09:00:00',
      run_key: '20260515_090000',
      output_path: outputPath
    })

    expect(run).toMatchObject({
      output_content: null,
      error: expect.stringContaining('File too large')
    })
  })

  it('uses a count-only path for remote Hermes manager listing run counts', async () => {
    const { handler, requestHandlers } = createHandlerHarness()
    const handlerInternals = handler as unknown as {
      readHermesRunCount: (jobId: string) => Promise<{ total: number }>
    }
    handlerInternals.readHermesRunCount = vi.fn().mockResolvedValue({ total: 42 })

    const result = (await requestHandlers.get('externalAutomations.runs')?.({
      provider: 'hermes',
      jobId: 'job-1',
      page: 1,
      pageSize: 0
    })) as { total: number; runs: unknown[] }

    expect(result).toEqual({ total: 42, runs: [] })
  })

  it('reports when the remote run total is saturated', async () => {
    const { handler, requestHandlers } = createHandlerHarness()
    const handlerInternals = handler as unknown as {
      readHermesRunCount: () => Promise<{ total: number; totalSaturated: true }>
    }
    handlerInternals.readHermesRunCount = vi
      .fn()
      .mockResolvedValue({ total: 10_000, totalSaturated: true })

    await expect(
      requestHandlers.get('externalAutomations.runs')?.({
        provider: 'hermes',
        jobId: 'job-1',
        page: 1,
        pageSize: 0
      })
    ).resolves.toEqual({ total: 10_000, totalSaturated: true, runs: [] })
  })

  it('deduplicates concurrent remote Hermes count reads', async () => {
    const { handler, requestHandlers } = createHandlerHarness()
    let resolveRefs: (result: {
      refs: { id: string; run_at: string }[]
      saturated: boolean
    }) => void = () => {}
    const readHermesRunRefs = vi.fn(
      () =>
        new Promise<{ refs: { id: string; run_at: string }[]; saturated: boolean }>((resolve) => {
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
    resolveRefs({
      refs: [
        { id: 'job-1:2026-05-15_09-00-00.md', run_at: '2026-05-15T09:00:00' },
        { id: 'job-1:2026-05-16_09-00-00.md', run_at: '2026-05-16T09:00:00' }
      ],
      saturated: false
    })

    await expect(Promise.all([first, second])).resolves.toEqual([
      { total: 2, runs: [] },
      { total: 2, runs: [] }
    ])
  })

  it('clears the remote Hermes count cache after lifecycle actions', async () => {
    const { handler, requestHandlers } = createHandlerHarness()
    const readHermesRunRefs = vi
      .fn()
      .mockResolvedValueOnce({
        refs: [{ id: 'job-1:2026-05-15_09-00-00.md', run_at: '2026-05-15T09:00:00' }],
        saturated: false
      })
      .mockResolvedValueOnce({
        refs: [
          { id: 'job-1:2026-05-15_09-00-00.md', run_at: '2026-05-15T09:00:00' },
          { id: 'job-1:2026-05-16_09-00-00.md', run_at: '2026-05-16T09:00:00' }
        ],
        saturated: false
      })
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

  it('evicts oldest remote Hermes count cache entries when many job ids are observed', async () => {
    const { handler, requestHandlers } = createHandlerHarness()
    const readHermesRunRefs = vi.fn(async (jobId: string) =>
      jobId === 'job-0'
        ? {
            refs: [{ id: 'job-0:2026-05-15_09-00-00.md', run_at: '2026-05-15T09:00:00' }],
            saturated: false
          }
        : { refs: [], saturated: false }
    )
    const handlerInternals = handler as unknown as {
      readHermesRunRefs: typeof readHermesRunRefs
    }
    handlerInternals.readHermesRunRefs = readHermesRunRefs

    await expect(
      requestHandlers.get('externalAutomations.runs')?.({
        provider: 'hermes',
        jobId: 'job-0',
        page: 1,
        pageSize: 0
      })
    ).resolves.toEqual({ total: 1, runs: [] })

    for (let i = 1; i <= 200; i += 1) {
      await requestHandlers.get('externalAutomations.runs')?.({
        provider: 'hermes',
        jobId: `job-${i}`,
        page: 1,
        pageSize: 0
      })
    }

    await expect(
      requestHandlers.get('externalAutomations.runs')?.({
        provider: 'hermes',
        jobId: 'job-0',
        page: 1,
        pageSize: 0
      })
    ).resolves.toEqual({ total: 1, runs: [] })

    expect(readHermesRunRefs).toHaveBeenCalledTimes(202)
  })
})
