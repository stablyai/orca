/** Host calls a worker has in flight. One the worker cancels, or one still running when the
 *  worker exits, is aborted (so its effect, if not started, never starts) and its answer dropped. */
export class PluginWorkerHostCalls {
  private readonly calls = new Map<number, AbortController>()

  start(id: number): AbortSignal {
    const controller = new AbortController()
    this.calls.set(id, controller)
    return controller.signal
  }

  /** True while the call is still wanted, so its answer should reach the worker. */
  finish(id: number): boolean {
    return this.calls.delete(id)
  }

  cancel(id: number): void {
    this.calls.get(id)?.abort()
    this.calls.delete(id)
  }

  cancelAll(): void {
    for (const controller of this.calls.values()) {
      controller.abort()
    }
    this.calls.clear()
  }
}
