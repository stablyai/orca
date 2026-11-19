import { expect, it, vi } from 'vitest'
import { forgetLegacyPtyRoot, readLegacyPtyRootProcessId } from './legacy-pty-root-process'

const startTime = vi.hoisted((): { value: number | null } => ({ value: 1_000 }))
vi.mock('../../agent-session/ownership/agent-session-process-identity-probe', () => ({
  readProcessStartTimeMs: async () => startTime.value
}))

/** An older daemon: every listing returns all of its sessions, whatever was asked. */
const daemon = (
  prefix: string,
  sessions: number,
  incarnationId: string | undefined = 'incarnation-1',
  rootProcessId = process.pid
) => {
  const counts = { requests: 0, rows: 0 }
  return {
    counts,
    listProcesses: async () => {
      counts.requests += 1
      counts.rows += sessions
      return Array.from({ length: sessions }, (_, index) => ({
        id: `${prefix}-${index}`,
        ...(incarnationId ? { incarnationId } : {}),
        rootProcessId,
        cwd: '',
        title: ''
      }))
    }
  }
}

it.each([
  [300, 'incarnation-1', 1_000],
  [3_000, 'incarnation-1', 1_000],
  [300, undefined, 1_000],
  [3_000, undefined, 1_000],
  [300, 'incarnation-1', null],
  [3_000, 'incarnation-1', null]
])(
  'held terminals on an older daemon share one session listing across every retry (%i held, incarnation %s, start time %s)',
  async (held, incarnationId, startedAtMs) => {
    startTime.value = startedAtMs
    const prefix = `pty-${held}-${incarnationId}-${startedAtMs}`
    const controller = daemon(prefix, held, incarnationId)
    for (let wave = 0; wave < 12; wave++) {
      await Promise.all(
        Array.from({ length: held }, (_, index) =>
          expect(
            readLegacyPtyRootProcessId(controller, `${prefix}-${index}`, incarnationId)
          ).resolves.toBe(process.pid)
        )
      )
    }
    expect(controller.counts).toEqual({ requests: 1, rows: held })
  }
)

it('a terminal that exits is listed again on its next probe', async () => {
  startTime.value = 1_000
  const controller = daemon('pty-exited', 1)
  await readLegacyPtyRootProcessId(controller, 'pty-exited-0', 'incarnation-1')
  forgetLegacyPtyRoot('pty-exited-0')
  await readLegacyPtyRootProcessId(controller, 'pty-exited-0', 'incarnation-1')
  expect(controller.counts.requests).toBe(2)
})

it('a root that exited with an unreadable start time is not trusted', async () => {
  startTime.value = null
  // Why this PID: no live process holds PID 0x7ffffffe here.
  const controller = daemon('pty-dead-root', 1, 'incarnation-1', 0x7ffffffe)
  await expect(
    readLegacyPtyRootProcessId(controller, 'pty-dead-root-0', 'incarnation-1')
  ).resolves.toBeNull()
  await readLegacyPtyRootProcessId(controller, 'pty-dead-root-0', 'incarnation-1')
  expect(controller.counts.requests).toBe(2)
})
