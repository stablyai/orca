import { existsSync, readFileSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { PROVIDER_SUPERVISOR_MAX_STOP_MS } from '../provider-process/provider-process-supervisor'
import {
  alive,
  createSupervisedProbeRig,
  waitFor,
  type SupervisedProbeRig
} from '../codex/supervised-probe-owner.test-fixture'
import { probeOpenCodeLaunchModelContext } from './opencode-launch-model-context'

// Like `opencode serve`, it never exits on stdin end. It starts listening only after the session
// stdin-end grace, so a supervisor that treated the probe's stdin end as a stop would kill it first.
const SERVE = String.raw`
setTimeout(() => {
  const server = require('node:http').createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1')
    const location = { directory: url.searchParams.get('location[directory]') }
    const model = { id: 'model', providerID: 'provider', enabled: true }
    const bodies = {
      '/api/model': { location, data: [model] },
      '/api/agent': { location, data: [{ id: 'build', mode: 'primary', hidden: false }] },
      '/api/model/default': { location, data: model },
      '/api/config': [{ type: 'document', info: { default_agent: 'build' } }]
    }
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify(bodies[url.pathname]))
  })
  server.listen(0, '127.0.0.1', () => {
    process.stdout.write('server listening on http://127.0.0.1:' + server.address().port + '\n')
  })
}, 1500)
`

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
  it('reads the context after its stdin end, then stops the whole server group', async () => {
    rig = createSupervisedProbeRig()
    const executable = rig.writeStandIn('opencode', SERVE)

    const context = await probeOpenCodeLaunchModelContext({
      executable,
      cwd: rig.dir,
      env: { ...process.env, ...rig.env }
    })
    const stoppedAt = Date.now()
    const pids = await rig.readPids()

    expect(context).toEqual({
      primaryAgent: 'build',
      availableModels: ['provider/model'],
      primaryModel: null
    })
    expect(existsSync(rig.signalFile) && readFileSync(rig.signalFile, 'utf8')).toBe('SIGTERM')
    expect(alive(pids.provider)).toBe(false)
    // A descendant that ignores SIGTERM holds none of the probe's pipes, so a closed pipe never
    // proved it gone; only the supervisor's group SIGKILL ends it.
    expect(alive(pids.grandchild)).toBe(false)
    // Once the server exits on its SIGTERM, the rest of its group is killed at once, not after the
    // SIGTERM grace; every launch waits on this preflight.
    expect(stoppedAt - (rig.readEvents().SIGTERM ?? 0)).toBeLessThan(1_000)
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
