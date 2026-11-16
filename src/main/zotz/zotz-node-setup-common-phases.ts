import { ZOTZ_AUTOLOGON_URL } from '../../shared/zotz/zotz-node-setup-contract'
import type { ZotzNodeSetupEnvironment } from './zotz-node-setup-environment'
import type { ZotzNodeSetupPhase } from './zotz-node-setup-orchestrator'
import {
  findTailscaleCli,
  installTailscale,
  readTailscaleStatus,
  tailscaleDownloadUrl
} from './zotz-tailscale'

const TAILSCALE_POLL_MS = 3_000

export function tailscalePhase(environment: ZotzNodeSetupEnvironment): ZotzNodeSetupPhase {
  return {
    steps: ['tailscale'],
    run: async (context) => {
      const downloadUrl = tailscaleDownloadUrl(environment.platform)
      let status = await readTailscaleStatus(environment)
      if (!status.installed) {
        context.report('tailscale', 'installing')
        const installed = await installTailscale(environment)
        if (!installed.ok) {
          return { tailscale: { status: 'failed', detail: installed.detail, url: downloadUrl } }
        }
        status = await readTailscaleStatus(environment)
      }
      const deadline = environment.now() + environment.tailscaleWaitMs
      let loginRequested = false
      while (!status.running) {
        if (environment.now() >= deadline) {
          return {
            tailscale: {
              status: 'failed',
              detail: 'timed out waiting for Tailscale to log in and connect',
              url: status.authUrl ?? downloadUrl
            }
          }
        }
        const cli = findTailscaleCli(environment)
        if (cli && !status.authUrl && !loginRequested) {
          loginRequested = true
          // `login` publishes an AuthURL that the next status read returns; it exits once logged in.
          void environment.run(cli, ['login'], environment.tailscaleWaitMs)
        }
        context.report('tailscale', 'waiting for login', status.authUrl ?? undefined)
        await environment.sleep(TAILSCALE_POLL_MS)
        status = await readTailscaleStatus(environment)
      }
      context.setTailscaleIp(status.ip)
      return { tailscale: { status: 'done', detail: status.ip ?? undefined } }
    }
  }
}

export function keepAwakePhase(environment: ZotzNodeSetupEnvironment): ZotzNodeSetupPhase {
  return {
    steps: ['keepAwake'],
    run: async () => ({
      keepAwake: environment.isKeptAwake()
        ? { status: 'done' }
        : { status: 'failed', detail: 'the keep-awake assertion is not active' }
    })
  }
}

export function networkExposurePhase(environment: ZotzNodeSetupEnvironment): ZotzNodeSetupPhase {
  return {
    steps: ['networkExposure'],
    run: async () => {
      await environment.ensureNetworkExposure()
      return { networkExposure: { status: 'done', detail: `port ${environment.port}` } }
    }
  }
}

export function autologonPhase(): ZotzNodeSetupPhase {
  return {
    steps: ['autologon'],
    run: async () => ({
      autologon: { status: 'skipped', detail: 'manual', url: ZOTZ_AUTOLOGON_URL }
    })
  }
}
