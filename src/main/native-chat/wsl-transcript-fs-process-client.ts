import type {
  WslTranscriptFsProcessResponse,
  WslTranscriptFsReusableProcessCall
} from './wsl-transcript-fs-process-protocol'
import {
  decodeWslTranscriptFsProcessError,
  decodeWslTranscriptFsProcessValue
} from './wsl-transcript-fs-process-decode'
// Transport faults (spawn failure, child death) mean nothing was consulted —
// surfacing them as plain errors would read as "path missing"/"empty tree" to
// the discovery layers, which only rethrow WslTranscriptFsError.
import { wslTranscriptFsProcessFailureError } from './wsl-transcript-fs-error'
import {
  attachSlotChild,
  WSL_TRANSCRIPT_FS_PROCESS_CLOSE_TIMEOUT_MS,
  type HandleState,
  type ProcessSlot,
  type SlotDisposition,
  type WslTranscriptFsProcessFactory,
  type WslTranscriptFsProcessHandle
} from './wsl-transcript-fs-process-slot'
import { WslTranscriptFsProcessLanePool } from './wsl-transcript-fs-process-lane-pool'
import { sendWslTranscriptFsProcessRequest } from './wsl-transcript-fs-process-send'
import {
  processHandleUnavailableError,
  wslTranscriptFsHandleOwners
} from './wsl-transcript-fs-process-handle-owner'

export type { WslTranscriptFsProcessHandle } from './wsl-transcript-fs-process-slot'

export class WslTranscriptFsProcessClient {
  private readonly pool: WslTranscriptFsProcessLanePool
  private readonly handles = new WeakMap<WslTranscriptFsProcessHandle, HandleState>()
  /** Handles retired by a slot fault/kill, not by a clean close: reads on them
   *  are a transport condition, never a caller bug. */
  private readonly faultedHandles = new WeakSet<WslTranscriptFsProcessHandle>()
  private nextId = 1

  constructor(private readonly processFactory: WslTranscriptFsProcessFactory) {
    this.pool = new WslTranscriptFsProcessLanePool(
      () => this.createSlot(),
      (slot) => this.destroySlot(slot)
    )
  }

  async run<T>(request: WslTranscriptFsReusableProcessCall, signal: AbortSignal): Promise<T> {
    signal.throwIfAborted()
    const acquired = this.takeSlotOrThrow(signal)
    return acquired instanceof Promise
      ? acquired.then((slot) =>
          this.send<T>(this.pool.claim(slot, signal), request, signal, 'idle')
        )
      : this.send<T>(acquired, request, signal, 'idle')
  }

  async open(path: string, signal: AbortSignal): Promise<WslTranscriptFsProcessHandle> {
    signal.throwIfAborted()
    const acquired = this.takeSlotOrThrow(signal)
    const slot = acquired instanceof Promise ? await acquired : acquired
    this.pool.claim(slot, signal)
    const handleId = await this.send<number>(slot, { operation: 'open', path }, signal, 'pin')
    if (!this.pool.has(slot)) {
      throw wslTranscriptFsProcessFailureError('the process exited while opening a file')
    }
    const handle = Object.freeze({
      wslTranscriptFsProcessHandle: true as const
    })
    slot.handles.add(handle)
    this.handles.set(handle, { slot, handleId })
    wslTranscriptFsHandleOwners.set(handle, this)
    this.pool.park(slot)
    return handle
  }

  async read(
    handle: WslTranscriptFsProcessHandle,
    position: number,
    length: number,
    signal: AbortSignal
  ): Promise<Buffer> {
    signal.throwIfAborted()
    const state = this.handles.get(handle)
    if (!state) {
      throw processHandleUnavailableError(handle, this.faultedHandles)
    }
    const acquired = this.takeSlotOrThrow(signal)
    const slot = acquired instanceof Promise ? await acquired : acquired
    this.pool.claim(slot, signal)
    if (this.handles.get(handle) !== state || state.slot !== slot) {
      this.pool.park(slot)
      throw processHandleUnavailableError(handle, this.faultedHandles)
    }
    return this.send<Buffer>(
      slot,
      { operation: 'read', handleId: state.handleId, position, length },
      signal,
      'pinned'
    )
  }

  close(handle: WslTranscriptFsProcessHandle): Promise<void> {
    const state = this.handles.get(handle)
    if (!state) {
      return Promise.resolve()
    }
    if (!state.closePromise) {
      state.closePromise = this.performClose(handle, state)
      // The stored promise may reject before any caller chains onto it.
      void state.closePromise.catch(() => {})
    }
    return state.closePromise
  }

  // Why: closes bypass the gate and can arrive during a read. Queue them ahead
  // of later lane work so teardown cannot fork around the one-process bound.
  private async performClose(
    handle: WslTranscriptFsProcessHandle,
    state: HandleState
  ): Promise<void> {
    const controller = new AbortController()
    const timer = setTimeout(() => {
      controller.abort(new Error('WSL transcript file handle close timed out'))
      if (this.pool.has(state.slot) && state.slot.active) {
        this.rejectActive(
          state.slot,
          wslTranscriptFsProcessFailureError('the process was retired by a stuck close')
        )
        this.destroySlot(state.slot)
      }
    }, WSL_TRANSCRIPT_FS_PROCESS_CLOSE_TIMEOUT_MS)
    timer.unref?.()
    try {
      const acquired = this.takeSlotOrThrow(controller.signal, true)
      const slot = acquired instanceof Promise ? await acquired : acquired
      this.pool.claim(slot, controller.signal, () => this.destroySlot(slot))
      if (this.handles.get(handle) !== state) {
        this.pool.park(slot)
        return
      }
      await this.send<boolean>(
        slot,
        { operation: 'close', handleId: state.handleId },
        controller.signal,
        'close',
        handle
      )
    } finally {
      clearTimeout(timer)
    }
  }

  private send<T>(
    slot: ProcessSlot,
    request: Parameters<typeof sendWslTranscriptFsProcessRequest>[0]['request'],
    signal: AbortSignal,
    disposition: SlotDisposition,
    handle?: WslTranscriptFsProcessHandle
  ): Promise<T> {
    return sendWslTranscriptFsProcessRequest<T>({
      slot,
      id: this.nextId++,
      request,
      signal,
      disposition,
      handle,
      onAbort: (reason) => {
        this.rejectActive(slot, reason)
        this.destroySlot(slot)
      },
      onTransportFailure: (error) => {
        this.rejectActive(slot, wslTranscriptFsProcessFailureError(error))
        this.destroySlot(slot)
      }
    })
  }

  dispose(): void {
    const error = wslTranscriptFsProcessFailureError('the client was disposed')
    this.pool.beginDispose(error)
    for (const slot of this.pool.snapshot()) {
      this.rejectActive(slot, error)
      this.destroySlot(slot)
    }
  }

  private takeSlotOrThrow(
    signal: AbortSignal,
    prioritize = false
  ): ProcessSlot | Promise<ProcessSlot> {
    return this.pool.acquire(signal, prioritize)
  }

  private createSlot(): ProcessSlot {
    try {
      const child = this.processFactory()
      const slot = attachSlotChild(child, {
        onResponse: (response) => this.onResponse(slot, response),
        onFault: (error) => this.onFault(slot, error)
      })
      return slot
    } catch (error) {
      throw wslTranscriptFsProcessFailureError(error)
    }
  }

  private onResponse(slot: ProcessSlot, response: WslTranscriptFsProcessResponse): void {
    const call = slot.active
    if (!call || call.id !== response.id) {
      return
    }
    this.clearActive(slot)
    call.signal.removeEventListener('abort', call.onAbort)
    if (!response.ok) {
      call.reject(decodeWslTranscriptFsProcessError(response.error))
    } else {
      try {
        call.resolve(decodeWslTranscriptFsProcessValue(call.operation, response.value))
      } catch (error) {
        // An undecodable ok-response means the protocol is corrupt: fail the
        // call and retire the slot rather than leave the promise unsettled.
        call.reject(error)
        this.destroySlot(slot)
        return
      }
    }
    switch (call.disposition) {
      case 'idle':
        this.pool.park(slot)
        break
      case 'pin':
        if (!response.ok) {
          this.pool.park(slot)
        }
        break
      case 'pinned':
        this.pool.park(slot)
        break
      case 'close':
        if (!response.ok) {
          this.destroySlot(slot)
        } else {
          this.releaseHandle(slot, call.handle!)
          this.pool.park(slot)
        }
        break
    }
  }

  private onFault(slot: ProcessSlot, error: Error): void {
    if (!this.pool.has(slot)) {
      return
    }
    this.rejectActive(slot, wslTranscriptFsProcessFailureError(error))
    this.destroySlot(slot)
  }

  private clearActive(slot: ProcessSlot): void {
    slot.active = null
  }

  private rejectActive(slot: ProcessSlot, error: unknown): void {
    const call = slot.active
    this.clearActive(slot)
    if (!call) {
      return
    }
    call.signal.removeEventListener('abort', call.onAbort)
    call.reject(error)
  }

  private destroySlot(slot: ProcessSlot): void {
    if (!this.pool.retire(slot)) {
      return
    }
    for (const handle of slot.handles) {
      this.faultedHandles.add(handle)
    }
    this.releaseAllHandles(slot)
    slot.child.removeAllListeners()
    try {
      slot.child.kill('SIGKILL')
    } catch {
      // Teardown race: kill of an already-terminating child emits 'error' with
      // no listeners left, which throws synchronously; the child dies anyway.
    }
  }

  private releaseHandle(slot: ProcessSlot, handle: WslTranscriptFsProcessHandle): void {
    slot.handles.delete(handle)
    this.handles.delete(handle)
    // The owners entry stays (WeakMap, collected with the handle) so late
    // cross-module reads still reach this client for a classified rejection.
  }

  private releaseAllHandles(slot: ProcessSlot): void {
    for (const handle of slot.handles) {
      this.handles.delete(handle)
    }
    slot.handles.clear()
  }
}
