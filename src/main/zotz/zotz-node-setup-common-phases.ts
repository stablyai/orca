import { ZOTZ_AUTOLOGON_URL } from '../../shared/zotz/zotz-node-setup-contract'
import type { ZotzNodeSetupEnvironment } from './zotz-node-setup-environment'
import type { ZotzNodeSetupPhase, ZotzNodeSetupPhaseContext } from './zotz-node-setup-orchestrator'
import { processOutput } from './zotz-process-runner'
import {
  findTailscaleCli,
  grantLinuxTailscaleOperator,
  installTailscale,
  readTailscaleStatus,
  tailscaleDownloadUrl
} from './zotz-tailscale'

const TAILSCALE_POLL_MS = 3_000

function accessPrerequisiteFailure(context: ZotzNodeSetupPhaseContext): string | null {
  if (context.stepStatus('tailscale') !== 'done' || !context.tailscaleIp) {
    return 'requires Tailscale'
  }
  const firewall = context.stepStatus('firewall')
  if (firewall !== 'done' && firewall !== 'skipped') {
    return 'requires the firewall rule'
  }
  return null
}

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
      let loginError: string | null = null
      while (!status.running) {
        if (loginError) {
          return { tailscale: { status: 'failed', detail: loginError, url: downloadUrl } }
        }
        if (environment.now() >= deadline) {
          return {
            tailscale: {
              status: 'failed',
              detail: 'timed out waiting for Tailscale to log in and connect',
              url: status.authUrl ?? downloadUrl
            }
          }
        }
        const cli = await findTailscaleCli(environment)
        if (cli && !status.authUrl && !loginRequested) {
          loginRequested = true
          const operator = await grantLinuxTailscaleOperator(environment, cli, environment.username)
          if (!operator.ok) {
            return { tailscale: { status: 'failed', detail: operator.detail, url: downloadUrl } }
          }
          // `login` publishes an AuthURL that the next status read returns; it exits once logged in.
          void environment.run(cli, ['login'], environment.tailscaleWaitMs).then((result) => {
            if (result.code !== 0 && result.code !== null) {
              loginError = processOutput(result) || `tailscale login exited ${String(result.code)}`
            }
          })
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
    run: async (context) => {
      const blocked = accessPrerequisiteFailure(context)
      if (blocked) {
        return { keepAwake: { status: 'skipped', detail: blocked } }
      }
      return {
        keepAwake: environment.ensureKeptAwake()
          ? { status: 'done' }
          : { status: 'failed', detail: 'the keep-awake assertion is not active' }
      }
    }
  }
}

export function networkExposurePhase(environment: ZotzNodeSetupEnvironment): ZotzNodeSetupPhase {
  return {
    steps: ['networkExposure'],
    run: async (context) => {
      const blocked = accessPrerequisiteFailure(context)
      if (blocked) {
        return { networkExposure: { status: 'skipped', detail: blocked } }
      }
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
