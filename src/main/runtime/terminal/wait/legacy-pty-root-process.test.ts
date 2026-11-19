import { expect, it, vi } from 'vitest'
import { forgetLegacyPtyRoot, readLegacyPtyRootProcessId } from './legacy-pty-root-process'

vi.mock('../../agent-session/ownership/agent-session-process-identity-probe', () => ({
  readProcessStartTimeMs: async () => 1_000
}))

const daemon = (sessions: number, incarnationId: string | undefined = 'incarnation-1') => {
  const counts = { requests: 0, rows: 0 }
  return {
    counts,
    listProcesses: async (_host?: string, opts?: { ptyIds?: readonly string[] }) => {
      // Why count every session: an older daemon returns them all before the PTY filter.
      counts.requests += 1
      counts.rows += sessions
      return (opts?.ptyIds ?? []).map((id) => ({
        id,
        ...(incarnationId ? { incarnationId } : {}),
        rootProcessId: 42,
        cwd: '',
        title: ''
      }))
    }
  }
}

it.each([
  [300, 'incarnation-1'],
  [3_000, 'incarnation-1'],
  [300, undefined],
  [3_000, undefined]
])(
  'an older daemon lists its sessions once per held terminal, not once per retry (%i held, incarnation %s)',
  async (held, incarnationId) => {
    const controller = daemon(held, incarnationId)
    for (let wave = 0; wave < 12; wave++) {
      for (let index = 0; index < held; index++) {
        await expect(
          readLegacyPtyRootProcessId(
            controller,
            `pty-${held}-${incarnationId}-${index}`,
            incarnationId
          )
        ).resolves.toBe(42)
      }
    }
    expect(controller.counts).toEqual({ requests: held, rows: held * held })
  }
)

it('a terminal that exits is listed again on its next probe', async () => {
  const controller = daemon(1)
  await readLegacyPtyRootProcessId(controller, 'pty-exited', 'incarnation-1')
  forgetLegacyPtyRoot('pty-exited')
  await readLegacyPtyRootProcessId(controller, 'pty-exited', 'incarnation-1')
  expect(controller.counts.requests).toBe(2)
})
