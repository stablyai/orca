// Server-side keep-alive. A sandbox's provider session ends when its lease runs out, and the
// desktop renews the lease only while it is open. Work inside the VM (a busy agent, a build, a
// typing user over SSH) must keep the sandbox up with the laptop closed, under the same idle-sleep
// rule the desktop applies. The cron reads the VM's own activity before the lease lapses: busy
// renews it, idle past the idle-sleep window sleeps it, and a VM whose orcad is gone is left to lapse.
import { z } from 'zod'
import { ORCA_CLOUD_IDLE_SLEEP_MINUTES } from '../../../../src/shared/hosted-sandbox/hosted-sandbox-wire'
import type { SandboxProviderApi } from './sandbox-provider'
import { ProviderError } from './sandbox-provider'

/** Check this long before the lease lapses (the cron runs every 5 minutes). */
export const ACTIVITY_CHECK_BEFORE_LAPSE_MS = 12 * 60_000
/** A busy VM's lease is extended by this much (same as the desktop's renewal). */
export const ACTIVITY_RENEW_MS = 30 * 60_000
/** CPU above this, sampled over 1 s, is work even when orcad sees none (a build, a dev server, output). */
export const BUSY_CPU_PERCENT = 15
/** orcad rewrites its verdict every minute; older than this means it stopped answering. */
const VERDICT_FRESH_MS = 5 * 60_000

/** orcad's beacon file: the same verdict the desktop polls over RPC (orcad.workVerdict). */
export const WORK_VERDICT_FILE = '$HOME/.orca-sandbox/work-verdict.json'

export const ACTIVITY_SCRIPT = String.raw`
set -u
cpu() { awk '/^cpu /{idle=$5+$6; t=0; for(i=2;i<=NF;i++) t+=$i; print t, idle}' /proc/stat; }
read t1 i1 < <(cpu); sleep 1; read t2 i2 < <(cpu)
dt=$((t2-t1)); di=$((i2-i1)); [ "$dt" -gt 0 ] || dt=1
cpu_pct=$(( (100*(dt-di)) / dt ))
orcad=false; pid=$(cat "$HOME/.orca-sandbox/orcad.pid" 2>/dev/null || echo 0); [ "$pid" -gt 1 ] 2>/dev/null && kill -0 "$pid" 2>/dev/null && orcad=true
verdict=$(head -c 2048 ${WORK_VERDICT_FILE} 2>/dev/null | tr -d '\n')
case "$verdict" in \{*\}) ;; *) verdict=null ;; esac
printf '{"cpuPercent":%d,"orcadAlive":%s,"nowMs":%s,"verdict":%s}\n' "$cpu_pct" "$orcad" "$(date +%s%3N)" "$verdict"
`.replaceAll('\\${', '${')

const VerdictSchema = z.object({
  verdict: z.enum(['idle', 'busy', 'unverifiable']),
  idleSince: z.number().nullable(),
  lastPtyInputAt: z.number().nullable(),
  at: z.number()
})

const ActivitySchema = z.object({
  cpuPercent: z.number().int().min(0).max(100),
  orcadAlive: z.boolean(),
  nowMs: z.number(),
  verdict: VerdictSchema.nullable().catch(null)
})
export type VmActivity = z.infer<typeof ActivitySchema>

export type ActivityDecision = 'renew' | 'sleep' | 'lapse' | 'wait'

/**
 * - `renew`: work is happening (agent, automation, recent typing, CPU) or orcad can't tell.
 * - `sleep`: orcad has read idle for the idle-sleep window and nothing else is going on.
 * - `wait`: idle, but not for long enough yet; a short renewal lets the next pass decide.
 * - `lapse`: no orcad (or no answer): nobody can use this VM, so the lease runs out as before.
 */
export function decideFromActivity(activity: VmActivity | null, idleSleepMinutes = ORCA_CLOUD_IDLE_SLEEP_MINUTES): ActivityDecision {
  if (!activity || !activity.orcadAlive) {
    return 'lapse'
  }
  const idleMs = idleSleepMinutes * 60_000
  const now = activity.nowMs
  if (activity.cpuPercent >= BUSY_CPU_PERCENT) {
    return 'renew'
  }
  const verdict = activity.verdict && now - activity.verdict.at <= VERDICT_FRESH_MS ? activity.verdict : null
  if (!verdict) {
    // An image without the beacon, or a stuck orcad: CPU said quiet, so let the lease decide.
    return 'lapse'
  }
  if (verdict.lastPtyInputAt !== null && now - verdict.lastPtyInputAt < idleMs) {
    return 'renew'
  }
  if (verdict.verdict !== 'idle') {
    return 'renew'
  }
  const idleFor = verdict.idleSince === null ? 0 : now - verdict.idleSince
  return idleFor >= idleMs ? 'sleep' : 'wait'
}

export async function readVmActivity(provider: SandboxProviderApi, sessionId: string): Promise<VmActivity | null> {
  try {
    const result = await provider.runCommand(sessionId, { command: 'bash', args: ['-c', ACTIVITY_SCRIPT], timeoutMs: 10_000 })
    if (result.exitCode !== 0) {
      return null
    }
    const parsed = ActivitySchema.safeParse(JSON.parse(result.stdout.trim().split('\n').at(-1) ?? ''))
    return parsed.success ? parsed.data : null
  } catch (error) {
    if (error instanceof ProviderError || error instanceof SyntaxError) {
      return null
    }
    throw error
  }
}
