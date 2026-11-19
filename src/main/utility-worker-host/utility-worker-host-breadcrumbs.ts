import type { CrashReportBreadcrumbData } from '../../shared/crash-reporting/crash-reporting'
import { recordDurableCrashBreadcrumb } from '../crash-reporting/breadcrumbs/durable-crash-breadcrumb'
import type { HostedWorker } from './hosted-worker'
import type { Host } from './utility-worker-host-process'
import { utilityWorkerHeapData } from './utility-worker-heap-report'

/** The host outlives a worker's own OOM, so no exit breadcrumb would name what it was doing. */
export function recordHostedWorkerFailure(
  serviceName: string,
  host: Host,
  worker: HostedWorker,
  code: string | undefined,
  context: CrashReportBreadcrumbData | undefined
): void {
  recordDurableCrashBreadcrumb('worker_thread_failed', {
    serviceName,
    role: worker.spawn.name,
    code: code ?? 'ERR_WORKER_OUT_OF_MEMORY',
    lastReply: worker.lastReplyType,
    receivedMB: Math.round(worker.receivedBytes / 2 ** 20),
    ...utilityWorkerHeapData(host.heap, [worker]),
    ...context
  })
}

/** Names each worker the dead host held and what its owner said it was doing. */
export function recordHostExited(
  serviceName: string,
  host: Host,
  workers: readonly HostedWorker[],
  code: number,
  context: CrashReportBreadcrumbData | undefined
): void {
  const data: CrashReportBreadcrumbData = {
    serviceName,
    code,
    workers: workers.length,
    ...utilityWorkerHeapData(host.heap, workers)
  }
  workers.forEach((worker, index) => {
    data[`w${index}_role`] = worker.spawn.name
    data[`w${index}_lastReply`] = worker.lastReplyType
    data[`w${index}_receivedMB`] = Math.round(worker.receivedBytes / 2 ** 20)
  })
  Object.assign(data, context)
  recordDurableCrashBreadcrumb('utility_worker_host_exited', data)
}
