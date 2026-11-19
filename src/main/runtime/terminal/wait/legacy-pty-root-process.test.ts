import { expect, it, vi } from 'vitest'
import { forgetLegacyPtyRoot, readLegacyPtyRootProcessId } from './legacy-pty-root-process'

vi.mock('../../agent-session/ownership/agent-session-process-identity-probe', () => ({
  readProcessStartTimeMs: async () => 1_000
}))

const daemon = (sessions: number) => {
  const counts = { requests: 0, rows: 0 }
  return {
    counts,
    listProcesses: async (_host?: string, opts?: { ptyIds?: readonly string[] }) => {
      // Why count every session: an older daemon returns them all before the PTY filter.
      counts.requests += 1
      counts.rows += sessions
      return (opts?.ptyIds ?? []).map((id) => ({
        id,
        incarnationId: 'incarnation-1',
        rootProcessId: 42,
        cwd: '',
        title: ''
      }))
    }
  }
}

it.each([300, 3_000])(
  'an older daemon lists its sessions once per held terminal, not once per retry (%i held)',
  async (held) => {
    const controller = daemon(held)
    for (let wave = 0; wave < 12; wave++) {
      for (let index = 0; index < held; index++) {
        await expect(
          readLegacyPtyRootProcessId(controller, `pty-${held}-${index}`, 'incarnation-1')
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
