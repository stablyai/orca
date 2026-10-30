import { describe, expect, it } from 'vitest'
import {
  createWslOrcadEnsureTrace,
  medianWslOrcadEnsurePhases,
  summarizeWslOrcadEnsurePhases,
  type WslOrcadEnsureMark,
  type WslOrcadEnsureTraceEvent
} from './wsl-orcad-ensure-phase-trace'

const mark = (name: WslOrcadEnsureMark, atMs: number): WslOrcadEnsureTraceEvent => ({
  kind: 'mark',
  mark: name,
  atMs
})
const command = (text: string, atMs: number): WslOrcadEnsureTraceEvent => ({
  kind: 'command',
  command: text,
  atMs
})

const LAUNCH = `sh -c 'echo $$ > "$1" && exec "$@"' orcad-launch "$orcad_pid"`
const READINESS_WAIT = 'orcad_readiness_wait_end=$(($(date +%s) + 20));'

describe('summarizeWslOrcadEnsurePhases', () => {
  it('splits a restart that launches orcad into boot, holder, checks, startup and bridge', () => {
    const phases = summarizeWslOrcadEnsurePhases([
      mark('ensure-start', 0),
      mark('deploy-start', 20),
      command('uname -r', 30),
      mark('holder-start', 700),
      mark('holder-end', 1000),
      command('cat orcad-active.json', 1020),
      command('mkdir .install-lock', 1040),
      command(LAUNCH, 1100),
      command(READINESS_WAIT, 1180),
      command('cat .orcad-pid', 3900),
      mark('deploy-end', 3950),
      mark('bridge-start', 3960),
      mark('bridge-end', 4010),
      mark('pairing-start', 4010),
      mark('pairing-end', 4150),
      mark('ensure-end', 4160)
    ])

    expect(phases).toEqual({
      totalMs: 4160,
      gateMs: 20,
      firstExecAndBootMs: 680,
      holderMs: 300,
      preLaunchChecksMs: 100,
      preLaunchCommands: 2,
      launchMs: 80,
      orcadStartupMs: 2720,
      postReadinessMs: 50,
      postReadinessCommands: 1,
      bridgeMs: 50,
      pairingMs: 140,
      unattributedMs: 20
    })
  })

  it('counts repeated readiness waits as orcad startup', () => {
    const phases = summarizeWslOrcadEnsurePhases([
      mark('ensure-start', 0),
      mark('deploy-start', 0),
      mark('holder-start', 0),
      mark('holder-end', 0),
      command(LAUNCH, 10),
      command(READINESS_WAIT, 20),
      command(READINESS_WAIT, 20_020),
      mark('deploy-end', 21_000),
      mark('ensure-end', 21_000)
    ])

    expect(phases).toMatchObject({ launchMs: 10, orcadStartupMs: 20_980, postReadinessMs: 0 })
  })

  it('reports no launch when orcad was already serving', () => {
    const phases = summarizeWslOrcadEnsurePhases([
      mark('ensure-start', 0),
      mark('deploy-start', 0),
      mark('holder-start', 0),
      mark('holder-end', 100),
      command('cat orcad-active.json', 110),
      command('head -c 262145 .orcad-readiness', 130),
      mark('deploy-end', 200),
      mark('ensure-end', 200)
    ])

    expect(phases).toMatchObject({
      launchMs: null,
      orcadStartupMs: null,
      preLaunchChecksMs: 100,
      preLaunchCommands: 2,
      postReadinessCommands: 0,
      unattributedMs: 0
    })
  })

  it('gives up when a connect never reached the deploy', () => {
    expect(
      summarizeWslOrcadEnsurePhases([mark('ensure-start', 0), mark('ensure-end', 5)])
    ).toBeNull()
  })
})

describe('createWslOrcadEnsureTrace', () => {
  it('marks a span even when its work fails', async () => {
    const times = [5, 9]
    const trace = createWslOrcadEnsureTrace(() => times.shift() ?? Number.NaN)

    await expect(
      trace.span('holder-start', 'holder-end', () => Promise.reject(new Error('boot failed')))
    ).rejects.toThrow('boot failed')

    expect(trace.events).toEqual([mark('holder-start', 5), mark('holder-end', 9)])
  })
})

describe('medianWslOrcadEnsurePhases', () => {
  it('takes each phase median and drops phases a run could not measure', () => {
    const base = summarizeWslOrcadEnsurePhases([
      mark('ensure-start', 0),
      mark('deploy-start', 0),
      mark('holder-start', 0),
      mark('holder-end', 0),
      mark('deploy-end', 0),
      mark('ensure-end', 0)
    ])
    if (!base) {
      throw new Error('expected phases')
    }

    const medians = medianWslOrcadEnsurePhases([
      { ...base, totalMs: 300, launchMs: 5 },
      null,
      { ...base, totalMs: 100, launchMs: null },
      { ...base, totalMs: 200, launchMs: 7 }
    ])

    expect(medians.totalMs).toBe(200)
    expect(medians).not.toHaveProperty('launchMs')
  })
})
