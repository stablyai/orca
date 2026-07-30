import type { ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import type { SupervisedDesktopProviderResult } from './computer-provider-supervisor-protocol'
import {
  createDesktopScriptProviderSupervisorDeps,
  desktopProviderCommandArgs,
  desktopProviderExecutionPlan,
  desktopProviderExecutionResult,
  DESKTOP_PROVIDER_MAX_BUFFER_BYTES,
  type DesktopProviderExecutionPlan,
  type DesktopScriptProviderSupervisorDeps
} from './desktop-script-provider-process-invocation'
import { serializeDesktopScriptProviderRequest } from './desktop-script-provider-request-validation'
import type { BridgeRequest } from './desktop-script-provider-types'
import { RuntimeClientError } from './runtime-client-error'

export const DESKTOP_PROVIDER_REQUEST_TIMEOUT_MS = 30_000
export const DESKTOP_PROVIDER_FORCE_KILL_GRACE_MS = 1_000

type DesktopProviderOperation = {
  id: string
  platform: DesktopProviderExecutionPlan['platform']
  child: ChildProcess | null
  directory: string | null
  settled: boolean
  terminating: boolean
  exitConfirmed: boolean
  callbackResult: SupervisedDesktopProviderResult | null
  deadlineTimer: NodeJS.Timeout | null
  forceKillTimer: NodeJS.Timeout | null
  resolve: (result: SupervisedDesktopProviderResult) => void
  reject: (error: Error) => void
  cleanupListeners: () => void
}

function ignoreUnownedChildError(): void {}

export class DesktopScriptProviderSupervisor {
  private readonly operations = new Map<string, DesktopProviderOperation>()
  private executionPlan: DesktopProviderExecutionPlan | null = null

  constructor(
    private readonly deps: DesktopScriptProviderSupervisorDeps = createDesktopScriptProviderSupervisorDeps()
  ) {}

  execute(request: BridgeRequest): Promise<SupervisedDesktopProviderResult> {
    const plan = this.executionPlan ?? desktopProviderExecutionPlan(this.deps)
    this.executionPlan = plan
    let resolve = (_result: SupervisedDesktopProviderResult): void => {}
    let reject = (_error: Error): void => {}
    const result = new Promise<SupervisedDesktopProviderResult>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise
      reject = rejectPromise
    })
    const operation: DesktopProviderOperation = {
      id: this.deps.randomUUID(),
      platform: plan.platform,
      child: null,
      directory: null,
      settled: false,
      terminating: false,
      exitConfirmed: false,
      callbackResult: null,
      deadlineTimer: null,
      forceKillTimer: null,
      resolve,
      reject,
      cleanupListeners: () => {}
    }
    this.operations.set(operation.id, operation)
    void this.prepareAndSpawn(operation, plan, request)
    return result
  }

  shutdown(): void {
    for (const operation of this.operations.values()) {
      operation.terminating = true
      this.clearOperationTimers(operation)
      this.rejectRequest(
        operation,
        new RuntimeClientError('accessibility_error', 'desktop provider supervisor shut down')
      )
      if (!operation.child || operation.exitConfirmed) {
        this.finishOperation(operation)
        continue
      }
      try {
        operation.child.kill('SIGKILL')
      } catch {}
    }
  }

  private async prepareAndSpawn(
    operation: DesktopProviderOperation,
    plan: DesktopProviderExecutionPlan,
    request: BridgeRequest
  ): Promise<void> {
    try {
      const directory = await this.deps.mkdtemp(
        join(this.deps.temporaryDirectory(), 'orca-computer-use-')
      )
      operation.directory = directory
      if (!this.isRegistered(operation) || operation.terminating) {
        this.removeOperationDirectory(operation)
        return
      }
      await this.deps.chmod(directory, 0o700)
      if (!this.isRegistered(operation) || operation.terminating) {
        this.removeOperationDirectory(operation)
        return
      }
      const operationPath = join(directory, 'operation.json')
      await this.deps.writeFile(operationPath, serializeDesktopScriptProviderRequest(request), {
        encoding: 'utf8',
        mode: 0o600
      })
      if (!this.isRegistered(operation) || operation.terminating) {
        this.removeOperationDirectory(operation)
        return
      }
      this.spawnOperation(operation, plan, operationPath)
    } catch (error) {
      if (this.isRegistered(operation)) {
        this.failBeforeSpawn(operation, error)
      } else {
        this.removeOperationDirectory(operation)
      }
    }
  }

  private spawnOperation(
    operation: DesktopProviderOperation,
    plan: DesktopProviderExecutionPlan,
    operationPath: string
  ): void {
    const args = desktopProviderCommandArgs(plan, operationPath)
    let child: ChildProcess | null = null
    try {
      child = this.deps.execFile(
        plan.command,
        args,
        {
          env: plan.env,
          encoding: 'utf8',
          maxBuffer: DESKTOP_PROVIDER_MAX_BUFFER_BYTES,
          windowsHide: true
        },
        (error, stdout, stderr) => {
          operation.callbackResult = desktopProviderExecutionResult(error, stdout, stderr)
          this.completeAfterCallback(operation)
        }
      )
      child.on('error', ignoreUnownedChildError)
      if (typeof child.pid !== 'number' || child.pid <= 0) {
        throw new Error('desktop provider process did not report a pid')
      }
    } catch (error) {
      try {
        child?.kill('SIGKILL')
      } catch {}
      this.failBeforeSpawn(operation, error)
      return
    }

    operation.child = child
    const onError = (error: Error): void => this.handleChildError(operation, error)
    const onExit = (): void => this.handleChildExit(operation)
    child.on('error', onError)
    child.once('exit', onExit)
    child.off('error', ignoreUnownedChildError)
    operation.cleanupListeners = () => {
      child.off('error', onError)
      child.off('exit', onExit)
      child.off('error', ignoreUnownedChildError)
      child.on('error', ignoreUnownedChildError)
    }
    operation.deadlineTimer = this.deps.setTimer(
      () => this.handleDeadline(operation),
      DESKTOP_PROVIDER_REQUEST_TIMEOUT_MS
    )
  }

  private completeAfterCallback(operation: DesktopProviderOperation): void {
    if (
      !this.isRegistered(operation) ||
      operation.settled ||
      !operation.exitConfirmed ||
      !operation.callbackResult
    ) {
      return
    }
    const result = operation.callbackResult
    operation.settled = true
    this.finishOperation(operation)
    operation.resolve(result)
  }

  private handleChildError(operation: DesktopProviderOperation, error: Error): void {
    if (!this.isRegistered(operation) || operation.terminating) {
      return
    }
    operation.terminating = true
    this.clearOperationTimers(operation)
    this.rejectRequest(
      operation,
      new RuntimeClientError('accessibility_error', `desktop provider failed: ${error.message}`)
    )
    try {
      operation.child?.kill('SIGKILL')
    } catch {}
  }

  private handleChildExit(operation: DesktopProviderOperation): void {
    if (!this.isRegistered(operation)) {
      return
    }
    operation.exitConfirmed = true
    if (operation.settled) {
      this.finishOperation(operation)
      return
    }
    this.completeAfterCallback(operation)
  }

  private handleDeadline(operation: DesktopProviderOperation): void {
    if (!this.isRegistered(operation) || operation.terminating) {
      return
    }
    operation.terminating = true
    operation.deadlineTimer = null
    this.rejectRequest(
      operation,
      new RuntimeClientError(
        'action_timeout',
        `desktop provider timed out after ${DESKTOP_PROVIDER_REQUEST_TIMEOUT_MS}ms`
      )
    )
    if (operation.exitConfirmed) {
      this.finishOperation(operation)
      return
    }
    try {
      operation.child?.kill(operation.platform === 'windows' ? 'SIGKILL' : 'SIGTERM')
    } catch {}
    if (operation.platform === 'windows') {
      return
    }
    operation.forceKillTimer = this.deps.setTimer(() => {
      operation.forceKillTimer = null
      try {
        operation.child?.kill('SIGKILL')
      } catch {}
    }, DESKTOP_PROVIDER_FORCE_KILL_GRACE_MS)
  }

  private failBeforeSpawn(operation: DesktopProviderOperation, error: unknown): void {
    if (!this.isRegistered(operation)) {
      this.removeOperationDirectory(operation)
      return
    }
    this.operations.delete(operation.id)
    this.removeOperationDirectory(operation)
    this.rejectRequest(
      operation,
      new RuntimeClientError(
        'accessibility_error',
        error instanceof Error ? error.message : String(error)
      )
    )
  }

  private finishOperation(operation: DesktopProviderOperation): void {
    if (!this.isRegistered(operation)) {
      return
    }
    this.operations.delete(operation.id)
    this.clearOperationTimers(operation)
    operation.cleanupListeners()
    this.removeOperationDirectory(operation)
  }

  private rejectRequest(operation: DesktopProviderOperation, error: Error): void {
    if (operation.settled) {
      return
    }
    operation.settled = true
    operation.reject(error)
  }

  private clearOperationTimers(operation: DesktopProviderOperation): void {
    if (operation.deadlineTimer) {
      this.deps.clearTimer(operation.deadlineTimer)
      operation.deadlineTimer = null
    }
    if (operation.forceKillTimer) {
      this.deps.clearTimer(operation.forceKillTimer)
      operation.forceKillTimer = null
    }
  }

  private removeOperationDirectory(operation: DesktopProviderOperation): void {
    if (!operation.directory) {
      return
    }
    const directory = operation.directory
    operation.directory = null
    try {
      this.deps.rmSync(directory, {
        recursive: true,
        force: true,
        maxRetries: 3,
        retryDelay: 100
      })
    } catch {}
  }

  private isRegistered(operation: DesktopProviderOperation): boolean {
    return this.operations.get(operation.id) === operation
  }
}
