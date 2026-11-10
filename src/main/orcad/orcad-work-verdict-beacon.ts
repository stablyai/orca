// Orca Cloud only: publish orcad's work verdict to a file the control plane reads from inside the
// VM. With the laptop closed nobody polls orcad.workVerdict, yet a busy agent must keep the sandbox
// up and an idle one must still go to sleep; the control plane's cron decides from this file.
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { OrcadWorkVerdict } from '../../shared/hosted-sandbox/hosted-session-events'
import { readOrcadWorkVerdict } from './orcad-work-verdict'

export const WORK_VERDICT_BEACON_INTERVAL_MS = 60_000

/** Same path as WORK_VERDICT_FILE in cloud/apps/sandbox-control/src/vm-activity.ts. */
export function workVerdictBeaconPath(home = homedir()): string {
  return join(home, '.orca-sandbox', 'work-verdict.json')
}

export async function writeWorkVerdictBeacon(
  path: string,
  verdict: OrcadWorkVerdict,
  now = Date.now()
): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true })
  const tmp = `${path}.tmp`
  await writeFile(tmp, `${JSON.stringify({ ...verdict, at: now })}\n`, 'utf8')
  await rename(tmp, path)
}

/** Starts the beacon when this orcad serves an Orca Cloud sandbox (ORCA_SANDBOX_ID is set). */
export function startOrcadWorkVerdictBeacon(
  readLatestInputAt: () => number | null,
  env: NodeJS.ProcessEnv = process.env,
  readVerdict: () => Promise<OrcadWorkVerdict> = () => readOrcadWorkVerdict(readLatestInputAt())
): () => void {
  if (!env.ORCA_SANDBOX_ID) {
    return () => {}
  }
  const path = workVerdictBeaconPath()
  const beat = (): void => {
    void readVerdict()
      .then((verdict) => writeWorkVerdictBeacon(path, verdict))
      .catch(() => undefined)
  }
  beat()
  const timer = setInterval(beat, WORK_VERDICT_BEACON_INTERVAL_MS)
  timer.unref?.()
  return () => clearInterval(timer)
}
