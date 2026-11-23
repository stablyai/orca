import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { OrcadTerminalCensus } from '../../../shared/remote-runtime/orcad-lifecycle/orcad-terminal-census'
import type { OrcadSlotOptions } from '../../managed-server/activation/orcad-recovery-slot'
import type { OrcadRemoteContext } from '../../managed-server/install/orcad-remote-context'
import type { ServeReadiness } from '../../server/serve-readiness'
import type { WslOrcadHostTarget } from './wsl-orcad-host-target'
import type { WslOrcadIncumbent } from './wsl-orcad-incumbent'

type RestartCounts = {
  recountCensus: () => Promise<OrcadTerminalCensus>
  refuseOtherWork?: (census: OrcadTerminalCensus) => string | null
}

const { stopIdleOrcadForRestart, wakeStoppedManagedOrcad } = vi.hoisted(() => ({
  stopIdleOrcadForRestart: vi.fn(),
  wakeStoppedManagedOrcad: vi.fn()
}))
vi.mock('../../managed-server/lifecycle/orcad-idle-restart-stop', () => ({
  stopIdleOrcadForRestart
}))
vi.mock('../../managed-server/lifecycle/orcad-managed-wake', () => ({ wakeStoppedManagedOrcad }))

const { relaunchAsWslHost } = await import('./wsl-orcad-host-relaunch')

const IDLE: OrcadTerminalCensus = {
  liveSessions: 0,
  startedSinceActivation: 0,
  daemonProtocolVersion: null,
  inProcessSessions: 0,
  chatSessions: 0,
  answered: true
}

let environment = 0

function relaunch(census: OrcadTerminalCensus, recounted: OrcadTerminalCensus = census) {
  const incumbent: WslOrcadIncumbent = {
    census,
    readiness: null,
    recount: async () => recounted,
    releaseAdmission: async () => {}
  }
  // Restarts are remembered per environment for the session; keep cases independent.
  environment += 1
  return relaunchAsWslHost({
    environmentId: `wsl-${environment}`,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the stubbed incumbent read and stop never touch the context.
    context: {} as OrcadRemoteContext<WslOrcadHostTarget>,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the mocked stop and wake never touch the slot.
    slot: {} as OrcadSlotOptions,
    fullVersion: '1.4.269',
    paired: null,
    moveRunning: false,
    readIncumbent: async () => incumbent,
    reprobe: async () => ({
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the relaunch only passes readiness through.
      readiness: {} as ServeReadiness,
      launch: 'wsl-host' as const
    })
  })
}

describe('relaunchAsWslHost', () => {
  beforeEach(() => {
    stopIdleOrcadForRestart.mockReset()
    wakeStoppedManagedOrcad.mockReset()
    // Mirrors the fenced stop: recount, then refuse on the caller's other-work check.
    stopIdleOrcadForRestart.mockImplementation(async (_slot: unknown, counts: RestartCounts) => {
      const reason = counts.refuseOtherWork?.(await counts.recountCensus()) ?? null
      return reason === null ? { state: 'retired', version: '1.4.269' } : { state: 'kept', reason }
    })
    wakeStoppedManagedOrcad.mockResolvedValue({ outcome: 'started' })
  })

  it('restarts a server with no terminals and no chats', async () => {
    const result = await relaunch(IDLE)
    expect(result).toMatchObject({ ready: true, deferredUpdate: null })
    expect(stopIdleOrcadForRestart).toHaveBeenCalledTimes(1)
    expect(wakeStoppedManagedOrcad).toHaveBeenCalledTimes(1)
  })

  it('keeps a server running a native chat with no terminals', async () => {
    const result = await relaunch({ ...IDLE, chatSessions: 1 })
    expect(result).toMatchObject({
      ready: true,
      deferredUpdate: { reason: expect.stringContaining('1 chat runs on it') }
    })
    expect(stopIdleOrcadForRestart).not.toHaveBeenCalled()
  })

  it('treats a server that cannot report its chats as running one', async () => {
    const { chatSessions: _, ...older } = IDLE
    for (const census of [older, { ...IDLE, chatSessions: null }]) {
      const result = await relaunch(census)
      expect(result).toMatchObject({
        ready: true,
        deferredUpdate: { reason: expect.stringContaining('could not tell whether a chat runs') }
      })
    }
    expect(stopIdleOrcadForRestart).not.toHaveBeenCalled()
  })

  it('keeps the server when a chat starts before the fenced recount', async () => {
    const result = await relaunch(IDLE, { ...IDLE, chatSessions: 2 })
    expect(result).toMatchObject({
      ready: true,
      deferredUpdate: { reason: expect.stringContaining('2 chats run on it') }
    })
    expect(wakeStoppedManagedOrcad).not.toHaveBeenCalled()
  })
})
