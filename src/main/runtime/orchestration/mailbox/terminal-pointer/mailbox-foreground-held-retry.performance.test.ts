import { afterEach, expect, it, vi } from 'vitest'

const identity = vi.hoisted(() => ({ reads: 0 }))
vi.mock('../../../agent-session/ownership/agent-session-process-identity-probe', async (load) => ({
  ...(await load<object>()),
  readProcessStartTimeMs: async () => {
    identity.reads++
    return 1
  }
}))

const { MailboxForegroundEvidence } = await import('./mailbox-foreground-evidence')

afterEach(() => {
  identity.reads = 0
  vi.restoreAllMocks()
})

it.each([100, 1000])('shell retries for %i held agents read no process identity', async (held) => {
  const kill = vi.spyOn(process, 'kill')
  const evidence = new MailboxForegroundEvidence()
  const ptys = Array.from({ length: held }, (_, i) => `pty-${i}`)
  for (const [i, ptyId] of ptys.entries()) {
    const probe = () => evidence.captureForegroundObservation(ptyId, 'incarnation')
    evidence.applyForeground(
      ptyId,
      { ...probe(), process: { pid: 4_000_000 + i, startedAtMs: 1 } },
      'agent',
      true
    )
    evidence.applyForeground(ptyId, probe(), 'shell')
  }
  await Promise.all(
    ptys.map((ptyId) =>
      evidence.probeForeground(ptyId, 'incarnation', async () => ({ foreground: 'shell' }))
    )
  )
  expect(identity.reads).toBe(0)
  expect(kill).toHaveBeenCalledTimes(0)
  expect(ptys.filter((ptyId) => evidence.foregroundHold(ptyId))).toHaveLength(held)
})
