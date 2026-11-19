import type { MessagePortMain, UtilityProcess } from 'electron'
import type { CrashReportBreadcrumbData } from '../../shared/crash-reporting/crash-reporting'
import type { HostedWorker } from './hosted-worker'
import type {
  UtilityWorkerHeapReport,
  UtilityWorkerHostRequest
} from './utility-worker-host-protocol'

/** One utility process a UtilityWorkerHost started, and the workers it holds. */
export type Host = {
  child: UtilityProcess
  ready: boolean
  queued: { request: UtilityWorkerHostRequest; port: MessagePortMain }[]
  workers: Map<number, HostedWorker>
  readyTimer: ReturnType<typeof setTimeout>
  idleTimer?: ReturnType<typeof setTimeout>
  retired: boolean
  /** Its loss is counted once, by whichever of port close or process exit main hears first. */
  lossCounted: boolean
  /** The owner's context, taken at the first port close, before any worker fails. */
  exitContext?: CrashReportBreadcrumbData
  heap?: UtilityWorkerHeapReport
}

export function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

/** A child still launching has no PID to kill yet; kill it once it has one. */
export function stopChild(host: Host): void {
  if (!host.child.kill()) {
    host.child.once('spawn', () => host.child.kill())
  }
}
