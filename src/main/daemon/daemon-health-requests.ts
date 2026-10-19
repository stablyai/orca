import { readCurrentProcessMacSystemResolverHealth } from '../network/macos-system-resolver-health'
import { getMacosFullDiskAccessStatus } from '../macos-full-disk-access-status'
import { ptySpawnHealthPlatformCoverage } from './daemon-health-identity'
import { checkDaemonAsyncIo } from './daemon-async-io-probe'
import type { DaemonFileLog } from './daemon-file-log'

export type PingRequest = {
  id: string
  type: 'ping'
}

export type SystemResolverHealthRequest = {
  id: string
  type: 'systemResolverHealth'
}

export type PtySpawnHealthRequest = {
  id: string
  type: 'ptySpawnHealth'
}

export type AsyncIoHealthRequest = {
  id: string
  type: 'asyncIoHealth'
}

export type FullDiskAccessStatusRequest = {
  id: string
  type: 'fullDiskAccessStatus'
}

type HealthRequest =
  | PingRequest
  | SystemResolverHealthRequest
  | PtySpawnHealthRequest
  | AsyncIoHealthRequest
  | FullDiskAccessStatusRequest

export class DaemonHealthRequests {
  private asyncIoStalled = false

  constructor(
    private readonly ptySpawnHealthCheck: () => Promise<void>,
    private readonly log: Pick<DaemonFileLog, 'log'>
  ) {}

  async handle(request: HealthRequest): Promise<unknown> {
    switch (request.type) {
      case 'ping':
        return { pong: true }
      case 'systemResolverHealth':
        return { health: await readCurrentProcessMacSystemResolverHealth() }
      case 'fullDiskAccessStatus':
        return { status: await getMacosFullDiskAccessStatus() }
      case 'ptySpawnHealth':
        await this.ptySpawnHealthCheck()
        return { healthy: true, coverage: ptySpawnHealthPlatformCoverage() }
      case 'asyncIoHealth': {
        const health = await checkDaemonAsyncIo()
        const stalled = health.state === 'stalled'
        if (stalled !== this.asyncIoStalled) {
          this.asyncIoStalled = stalled
          this.log.log(stalled ? 'async-io-stalled' : 'async-io-recovered', {
            pendingMs: health.pendingMs
          })
        }
        return health
      }
    }
  }
}
