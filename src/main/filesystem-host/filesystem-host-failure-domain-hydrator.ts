import { assertWslUncPathRunning } from '../wsl/wsl-unc-access-gate'
import { windowsFsPath } from '../wsl/wsl-unc-drive-fs-path'
import {
  remainingFilesystemHostBudget,
  withinFilesystemHostDeadline
} from './filesystem-host-deadline'
import { randomUUID } from 'node:crypto'
import type { FilesystemHostResult } from '../../shared/filesystem-host-protocol'
import type { FilesystemExecutionHost } from './filesystem-host-failure-domain'
import type { FilesystemHostDispatch } from './filesystem-host-supervisor-scheduling'
import type { FilesystemStorageClass } from './filesystem-host-telemetry'
import type {
  FilesystemHostBackgroundQueue,
  FilesystemHostBackgroundAdmission
} from './filesystem-host-background-queue'

type FailureDomainSupervisor = {
  dispatch(input: FilesystemHostDispatch): Promise<FilesystemHostResult>
  publishFailureDomain(input: {
    executionHost: FilesystemExecutionHost
    prefix: string
    mountId: string
  }): void
  removeFailureDomain(input: { executionHost: FilesystemExecutionHost; prefix: string }): void
}

type RoutePath = (path: string) => {
  executionHost: FilesystemExecutionHost
  storageClass: FilesystemStorageClass
}

const CLASSIFICATION_RETRY_BASE_DELAY_MS = 25
const CLASSIFICATION_RETRY_MAX_DELAY_MS = 30_000

function isRetryableClassificationFailure(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    ['capacity', 'deadline', 'WSL_DISTRO_STOPPED', 'WSL_DISTRO_UNVERIFIABLE'].includes(
      String(error.code)
    )
  )
}

export class FilesystemHostFailureDomainHydrator {
  private readonly classifiedPaths = new Set<string>()
  private readonly flights = new Map<string, Promise<void>>()
  private readonly persistentPaths = new Set<string>()
  private catalogPaths = new Set<string>()
  private readonly readLeases = new Map<string, number>()
  private readonly retryAttempts = new Map<string, number>()
  private readonly retryTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private disposed = false

  constructor(
    private readonly supervisor: FailureDomainSupervisor,
    private readonly queue: FilesystemHostBackgroundQueue,
    private readonly routePath: RoutePath,
    private readonly deadlineMs: number,
    private readonly demandQueueForPath?: (path: string) => FilesystemHostBackgroundAdmission
  ) {}

  hydrate(paths: readonly string[]): void {
    for (const path of new Set(paths)) {
      this.persistentPaths.add(path)
      this.scheduleClassification(path)
    }
  }

  reconcile(paths: readonly string[]): void {
    const next = new Set(paths)
    const obsolete = new Set(
      [...this.catalogPaths].filter((path) => !next.has(path) && !this.isOwned(path, next))
    )
    for (const path of this.queue.cancelMany(obsolete)) {
      this.flights.delete(path)
    }
    for (const path of this.catalogPaths) {
      if (!next.has(path)) {
        this.evictIfUnowned(path, next)
      }
    }
    this.catalogPaths = next
    for (const path of next) {
      this.scheduleClassification(path)
    }
  }

  async acquire(path: string, expiresAt = Date.now() + this.deadlineMs): Promise<() => void> {
    this.readLeases.set(path, (this.readLeases.get(path) ?? 0) + 1)
    try {
      if (this.demandQueueForPath && this.queue.cancel(path)) {
        this.flights.delete(path)
      }
      await withinFilesystemHostDeadline(
        this.classify(path, expiresAt, this.demandQueueForPath?.(path)),
        expiresAt
      )
    } catch (error) {
      this.release(path)
      if (this.isOwned(path) && isRetryableClassificationFailure(error)) {
        this.scheduleClassificationRetry(path)
      }
      throw error
    }
    let released = false
    return () => {
      if (!released) {
        released = true
        this.release(path)
      }
    }
  }

  classify(
    path: string,
    expiresAt = Date.now() + this.deadlineMs,
    queue: FilesystemHostBackgroundAdmission = this.queue
  ): Promise<void> {
    if (this.classifiedPaths.has(path)) {
      return Promise.resolve()
    }
    const existing = this.flights.get(path)
    if (existing) {
      return existing
    }
    const route = this.routePath(path)
    const flight = queue
      .run(
        async () => {
          await withinFilesystemHostDeadline(assertWslUncPathRunning(path), expiresAt)
          const result = await this.supervisor.dispatch({
            operationId: randomUUID(),
            operation: { kind: 'classify-path', path: windowsFsPath(path) },
            ...route,
            admission: 'background',
            deadlineMs: remainingFilesystemHostBudget(expiresAt)
          })
          if (result.kind !== 'classify-path') {
            throw new Error('Filesystem host returned the wrong classification result')
          }
          if (this.isOwned(path)) {
            this.supervisor.publishFailureDomain({
              executionHost: route.executionHost,
              prefix: path,
              mountId: result.deviceId
            })
            this.classifiedPaths.add(path)
          }
        },
        path,
        expiresAt
      )
      .finally(() => {
        if (this.flights.get(path) === flight) {
          this.flights.delete(path)
        }
      })
    this.flights.set(path, flight)
    return flight
  }

  private release(path: string): void {
    const remaining = (this.readLeases.get(path) ?? 1) - 1
    if (remaining > 0) {
      this.readLeases.set(path, remaining)
      return
    }
    this.readLeases.delete(path)
    this.evictIfUnowned(path, this.catalogPaths)
  }

  private scheduleClassification(path: string): void {
    if (this.disposed) {
      return
    }
    void this.classify(path)
      .then(() => {
        this.clearRetry(path)
        if (this.isOwned(path) && !this.classifiedPaths.has(path)) {
          this.scheduleClassification(path)
        }
      })
      .catch((error: unknown) => {
        if (!this.disposed && this.isOwned(path) && isRetryableClassificationFailure(error)) {
          this.scheduleClassificationRetry(path)
        }
      })
  }

  dispose(): void {
    this.disposed = true
    for (const timer of this.retryTimers.values()) {
      clearTimeout(timer)
    }
    this.retryTimers.clear()
    this.retryAttempts.clear()
  }

  private isOwned(path: string, catalogPaths: ReadonlySet<string> = this.catalogPaths): boolean {
    return (
      this.persistentPaths.has(path) ||
      catalogPaths.has(path) ||
      (this.readLeases.get(path) ?? 0) > 0
    )
  }

  private evictIfUnowned(path: string, catalogPaths: ReadonlySet<string>): void {
    if (this.isOwned(path, catalogPaths)) {
      return
    }
    if (this.queue.cancel(path)) {
      this.flights.delete(path)
    }
    this.clearRetry(path)
    this.classifiedPaths.delete(path)
    const route = this.routePath(path)
    this.supervisor.removeFailureDomain({ executionHost: route.executionHost, prefix: path })
  }

  private scheduleClassificationRetry(path: string): void {
    if (this.disposed || this.retryTimers.has(path)) {
      return
    }
    const attempt = (this.retryAttempts.get(path) ?? 0) + 1
    this.retryAttempts.set(path, attempt)
    const delay = Math.min(
      CLASSIFICATION_RETRY_BASE_DELAY_MS * 2 ** Math.min(attempt - 1, 10),
      CLASSIFICATION_RETRY_MAX_DELAY_MS
    )
    const timer = setTimeout(() => {
      this.retryTimers.delete(path)
      if (!this.disposed && this.isOwned(path)) {
        this.scheduleClassification(path)
      }
    }, delay)
    timer.unref?.()
    this.retryTimers.set(path, timer)
  }

  private clearRetry(path: string): void {
    const timer = this.retryTimers.get(path)
    if (timer) {
      clearTimeout(timer)
      this.retryTimers.delete(path)
    }
    this.retryAttempts.delete(path)
  }
}
