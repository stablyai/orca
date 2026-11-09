// The verdict a session-capped host (Orca Cloud) polls to decide renew, idle sleep or rollover.
// Unlike idle exit it ignores open clients and live shells: a connected desktop is not work.
import type { OrcadWorkVerdict } from '../../shared/hosted-sandbox/hosted-session-events'
import type { OrcadIdleProbe } from './orcad-idle-exit-monitor'

let probes: readonly OrcadIdleProbe[] | null = null
let idleSince: number | null = null

/** orcad installs its work probes once serving; other runtimes answer unverifiable. */
export function installOrcadWorkProbes(ports: {
  agentStates: () => readonly { state: string }[]
  automationsBusy: () => boolean
  emulatorsBusy: () => Promise<boolean>
}): void {
  const verdict = (busy: boolean): 'busy' | 'idle' => (busy ? 'busy' : 'idle')
  probes = [
    { name: 'agents', read: () => verdict(ports.agentStates().some((e) => e.state === 'working')) },
    { name: 'automations', read: () => verdict(ports.automationsBusy()) },
    { name: 'emulators', read: async () => verdict(await ports.emulatorsBusy()) }
  ]
  idleSince = null
}

export async function readOrcadWorkVerdict(
  lastPtyInputAt: number | null,
  now = Date.now()
): Promise<OrcadWorkVerdict> {
  if (!probes) {
    return { verdict: 'unverifiable', idleSince: null, lastPtyInputAt }
  }
  for (const probe of probes) {
    const verdict = await Promise.resolve()
      .then(probe.read)
      .catch(() => 'unverifiable' as const)
    if (verdict !== 'idle') {
      idleSince = null
      return { verdict, idleSince: null, lastPtyInputAt }
    }
  }
  idleSince ??= now
  return { verdict: 'idle', idleSince, lastPtyInputAt }
}
