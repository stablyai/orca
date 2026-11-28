import { parentPort, workerData } from 'node:worker_threads'
import { isAbsolute } from 'node:path'
import { setAppEnvironment } from '../../../shared/app-lifecycle/app-environment'
import { createNodeServiceEnvironment } from '../../backend/node-service-environment'
import { installWorkerSendLedger } from '../../worker-threads/worker-send-ledger'
import { rexLaunchJob } from './rex-launch-worker-schema'
import { createRexLaunchPlan } from './rex-launch-plan'
import { encodeRexLaunch } from './rex-launch-gate'

installWorkerSendLedger('orca-rex-launch')
if (!parentPort) {
  throw new Error('Rex launch planning requires a worker')
}
const port = parentPort
const profile: unknown = workerData
if (typeof profile !== 'string' || !isAbsolute(profile)) {
  throw new Error('Invalid Rex launch profile')
}
process.env.ORCA_USER_DATA_PATH = profile
setAppEnvironment(
  createNodeServiceEnvironment({
    getPath(name) {
      if (name !== 'userData') {
        throw new Error('Unsupported Rex worker path')
      }
      return profile
    },
    getAppPath: () => profile,
    getVersion: () => process.env.ORCA_APP_VERSION ?? '0.0.0-dev',
    isPackaged: () => false
  }).environment
)
port.on('message', (message: unknown) => {
  const parsed = rexLaunchJob.safeParse(message)
  if (!parsed.success) {
    port.close()
    return
  }
  const { id, cwd, opts } = parsed.data
  try {
    if (parsed.data.profile !== profile || !isAbsolute(cwd)) {
      throw new Error('Invalid Rex launch paths')
    }
    const plan = createRexLaunchPlan(opts, cwd)
    const payload = encodeRexLaunch(plan.argv, plan.env, opts.envToDelete)
    try {
      port.postMessage({ id, ok: true, payload })
    } finally {
      payload.fill(0)
    }
  } catch {
    // Do not include exception text or environment contents in logs or worker responses.
    port.postMessage({ id, ok: false })
  }
})
