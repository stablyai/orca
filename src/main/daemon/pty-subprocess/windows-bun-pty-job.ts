import type { JobTerminationOutcome } from '../../windows/windows-pty-job'
import {
  __resetWindowsBunPtyNativeForTests,
  loadWindowsBunPtyJobNative,
  type WindowsBunPtyJobNative,
  type WindowsNativeHandle
} from './windows-bun-pty-native'

export type { WindowsBunPtyJobNative } from './windows-bun-pty-native'

export type WindowsBunPtyJob = {
  listProcessIds(): readonly number[] | null
  pause(): boolean
  resume(): boolean
  terminate(): JobTerminationOutcome
  close(): void
}

const JOB_OBJECT_LIMIT_BREAKAWAY_OK = 0x0000_0800
const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x0000_2000
const PROCESS_TERMINATE = 0x0001
const PROCESS_SET_QUOTA = 0x0100
const PROCESS_SUSPEND_RESUME = 0x0800
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
const MAX_SUSPEND_PASSES = 8

let hostJobAssigned: boolean | null = null

export function assignCurrentProcessToBunPtyHostJob(
  native: WindowsBunPtyJobNative | null = loadWindowsBunPtyJobNative()
): boolean {
  if (hostJobAssigned !== null) {
    return hostJobAssigned
  }
  if (!native) {
    hostJobAssigned = false
    return false
  }
  const job = native.createJob()
  if (
    job === null ||
    !native.configureJob(job, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_BREAKAWAY_OK) ||
    !native.assignProcess(job, native.currentProcess())
  ) {
    if (job !== null) {
      native.closeHandle(job)
    }
    hostJobAssigned = false
    return false
  }
  // The host job deliberately lives until Windows closes it during process teardown.
  hostJobAssigned = true
  return true
}

class BunPtyJob implements WindowsBunPtyJob {
  private readonly suspended = new Map<number, WindowsNativeHandle>()
  private closed = false
  private fullySuspended = false
  private terminated = false

  constructor(
    private readonly rootPid: number,
    private readonly handle: WindowsNativeHandle,
    private readonly native: WindowsBunPtyJobNative
  ) {}

  listProcessIds(): readonly number[] | null {
    return this.closed ? null : this.native.queryProcessIds(this.handle)
  }

  pause(): boolean {
    if (this.closed || this.terminated) {
      return false
    }
    if (this.fullySuspended) {
      return true
    }
    if (this.suspended.size > 0 && !this.resume()) {
      return false
    }
    for (let pass = 0; pass < MAX_SUSPEND_PASSES; pass += 1) {
      const pids = this.listProcessIds()
      if (!pids) {
        this.resume()
        return false
      }
      const ordered = [...pids].sort((left, right) => {
        if (left === this.rootPid) {
          return -1
        }
        if (right === this.rootPid) {
          return 1
        }
        return left - right
      })
      let progressed = false
      for (const pid of ordered) {
        if (this.suspended.has(pid)) {
          continue
        }
        const process = this.native.openProcess(
          PROCESS_SUSPEND_RESUME | PROCESS_QUERY_LIMITED_INFORMATION,
          pid
        )
        if (process === null) {
          continue
        }
        if (!this.native.isProcessInJob(process, this.handle)) {
          this.native.closeHandle(process)
          continue
        }
        if (!this.native.suspendProcess(process)) {
          this.native.closeHandle(process)
          continue
        }
        this.suspended.set(pid, process)
        progressed = true
      }
      const remaining = this.listProcessIds()
      if (remaining && remaining.every((pid) => this.suspended.has(pid))) {
        this.fullySuspended = true
        return true
      }
      if (!remaining || !progressed) {
        this.resume()
        return false
      }
    }
    this.resume()
    return false
  }

  resume(): boolean {
    this.fullySuspended = false
    let resumed = true
    const ownedPids = this.terminated ? [] : this.listProcessIds()
    for (const [pid, process] of this.suspended) {
      const processExited = ownedPids !== null && !ownedPids.includes(pid)
      if (!this.terminated && !processExited && !this.native.resumeProcess(process)) {
        resumed = false
        continue
      }
      this.native.closeHandle(process)
      this.suspended.delete(pid)
    }
    return resumed && this.suspended.size === 0
  }

  terminate(): JobTerminationOutcome {
    if (this.closed) {
      return this.terminated ? 'terminated' : 'unavailable'
    }
    if (!this.terminated) {
      this.terminated = this.native.terminateJob(this.handle)
    }
    if (this.terminated) {
      this.resume()
      return 'terminated'
    }
    return 'unavailable'
  }

  close(): void {
    if (this.closed) {
      return
    }
    if (!this.resume()) {
      console.warn(
        '[daemon/pty] Could not resume a Windows PTY tree during cleanup; terminating it'
      )
      this.terminated = this.native.terminateJob(this.handle)
      if (!this.terminated) {
        this.terminated = this.native.configureJob(
          this.handle,
          JOB_OBJECT_LIMIT_BREAKAWAY_OK | JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        )
      }
      this.resume()
    }
    this.native.closeHandle(this.handle)
    this.closed = true
  }
}

export function createWindowsBunPtyJob(
  rootPid: number,
  native: WindowsBunPtyJobNative | null = loadWindowsBunPtyJobNative()
): WindowsBunPtyJob | null {
  if (!native || !Number.isInteger(rootPid) || rootPid <= 0) {
    return null
  }
  const job = native.createJob()
  if (job === null || !native.configureJob(job, JOB_OBJECT_LIMIT_BREAKAWAY_OK)) {
    if (job !== null) {
      native.closeHandle(job)
    }
    return null
  }
  const process = native.openProcess(
    PROCESS_SET_QUOTA |
      PROCESS_TERMINATE |
      PROCESS_SUSPEND_RESUME |
      PROCESS_QUERY_LIMITED_INFORMATION,
    rootPid
  )
  if (process === null) {
    native.closeHandle(job)
    return null
  }
  const assigned = native.assignProcess(job, process)
  native.closeHandle(process)
  if (!assigned) {
    native.closeHandle(job)
    return null
  }
  return new BunPtyJob(rootPid, job, native)
}

export function __resetWindowsBunPtyJobForTests(): void {
  __resetWindowsBunPtyNativeForTests()
  hostJobAssigned = null
}
