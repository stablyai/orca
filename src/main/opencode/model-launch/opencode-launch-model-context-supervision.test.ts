import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { probeOpenCodeLaunchModelContext } from './opencode-launch-model-context'
import { PROVIDER_SUPERVISOR_MAX_STOP_MS } from '../../provider-process/provider-process-supervisor'
import {
  alive,
  createSupervisedProbeRig,
  waitFor,
  type SupervisedProbeRig
} from '../../codex/structured/session-lifecycle/supervised-probe-owner.test-fixture'

// Delay beyond stdin grace like a slow opencode serve startup; stdin EOF must not stop it.

const launch = vi.hoisted(() => vi.fn())
vi.mock('../../provider-process/provider-process-spawn', () => ({ spawnProviderProcess: launch }))

const OWNER = String.raw`
import { probeOpenCodeLaunchModelContext } from './opencode-launch-model-context'
void probeOpenCodeLaunchModelContext({
  executable: process.env.ORCA_TEST_STAND_IN!,
  cwd: process.cwd(),
  env: process.env
}).catch(() => {})
setInterval(() => {}, 60_000)
`

let rig: SupervisedProbeRig | null = null

afterEach(() => {
  rig?.cleanup()
  rig = null
})

describe.runIf(process.platform !== 'win32')('supervised OpenCode launch-context probe', () => {
  it('cancels an aborted preflight before its pending CLI has a public PID', async () => {
    const child = Object.assign(new EventEmitter(), {
      pid: undefined,
      ready: new Promise<void>(() => {}),
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      exitCode: null,
      signalCode: null,
      groupVerdict: 'unverifiable',
      kill: vi.fn(() => {
        child.groupVerdict = 'exited'
        child.emit('exit', null, null)
        child.emit('close', null, null)
        return false
      })
    })
    launch.mockReturnValueOnce(child)
    await expect(
      probeOpenCodeLaunchModelContext({
        executable: 'opencode',
        cwd: process.cwd(),
        env: process.env,
        signal: AbortSignal.abort()
      })
    ).resolves.toBeNull()
    expect(child.kill).toHaveBeenCalledWith('SIGTERM')
  })

  it('stops the server group when its owner is SIGKILLed mid-probe', async () => {
    rig = createSupervisedProbeRig()
    const executable = rig.writeStandIn('opencode')
    const bundle = await rig.bundleOwner(OWNER, __dirname)
    const owner = rig.launchOwner(bundle, { ORCA_TEST_STAND_IN: executable })
    const pids = await rig.readPids()

    owner.kill('SIGKILL')

    expect(
      await waitFor(
        () => !alive(pids.provider) && !alive(pids.grandchild),
        PROVIDER_SUPERVISOR_MAX_STOP_MS + 1_000
      )
    ).toBe(true)
  })
})
