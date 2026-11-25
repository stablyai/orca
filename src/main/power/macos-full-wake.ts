// Whether a Mac is in full wake, not a dark wake. A dark wake (Power Nap, maintenance, network
// wakes) runs the CPU with no graphics: XNU's root domain enters it by dropping
// kIOPMSystemCapabilityGraphics and leaves it by gaining it back, while display sleep alone keeps
// the capability. `pmset -g systemstate` prints the current capabilities, so the reading holds for
// a process that has seen no wake yet.
import { runProcess } from '@orca/process-host'

export type PmsetRun = (args: string[]) => Promise<string>

const PMSET = '/usr/bin/pmset'
const PMSET_TIMEOUT_MS = 2_000

const runPmset: PmsetRun = async (args) => {
  const result = await runProcess({
    program: PMSET,
    args,
    timeoutMs: PMSET_TIMEOUT_MS,
    maxOutputBytes: 4_096
  })
  if (result.timedOut || result.code !== 0) {
    throw new Error(`pmset exited ${result.timedOut ? 'on timeout' : `with ${result.code}`}`)
  }
  return result.stdout
}

/** The capabilities `pmset -g systemstate` lists; null when its output has none. */
export function parseSystemCapabilities(output: string): string[] | null {
  const line = /Current System Capabilities are:(.*)/.exec(output)
  return line ? line[1].trim().split(/\s+/).filter(Boolean) : null
}

let warnedUnread = false

/** Unknown is never full wake, so scheduled bot runs wait; say why, once. */
function warnUnreadOnce(output: string): void {
  if (!warnedUnread) {
    warnedUnread = true
    console.warn('[power] pmset listed no system capabilities; scheduled bot runs wait', output)
  }
}

/** What `pmset -g systemstate` said: `unlisted` when its output lists no capabilities, which
 *  persists for that output's format; `failed` when it didn't answer, which may pass. */
export type MacosWakeReading = 'full' | 'dark' | 'unlisted' | 'failed'

export async function readMacosWakeState(run: PmsetRun = runPmset): Promise<MacosWakeReading> {
  try {
    const output = await run(['-g', 'systemstate'])
    const capabilities = parseSystemCapabilities(output)
    if (capabilities === null) {
      warnUnreadOnce(output)
      return 'unlisted'
    }
    return capabilities.includes('Graphics') ? 'full' : 'dark'
  } catch (error) {
    console.warn('[power] could not read the system power state', error)
    return 'failed'
  }
}

/** True in full wake, false in a dark wake, null when the state can't be read. */
export async function readMacosFullWake(run: PmsetRun = runPmset): Promise<boolean | null> {
  return fullWakeOf(await readMacosWakeState(run))
}

export function fullWakeOf(reading: MacosWakeReading): boolean | null {
  return reading === 'full' ? true : reading === 'dark' ? false : null
}
