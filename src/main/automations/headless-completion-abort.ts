import type {
  HeadlessAutomationDispatcher,
  HeadlessAutomationDispatchLaunch
} from './headless-dispatch'

/** Tracks headless completion observers so AutomationService.stop() can abort them. */
export class HeadlessCompletionAbortRegistry {
  private readonly controllers = new Map<string, AbortController>()

  beginRun(runId: string): AbortController {
    const controller = new AbortController()
    this.controllers.set(runId, controller)
    return controller
  }

  wrapDispatcher(inner: HeadlessAutomationDispatcher): HeadlessAutomationDispatcher {
    return async (request) => {
      const controller = this.controllers.get(request.run.id)
      if (!controller || controller.signal !== request.completionSignal) {
        throw new Error('Headless completion abort must begin before dispatch.')
      }
      try {
        const launch = await inner(request)
        this.trackCompletion(request.run.id, controller, launch)
        return { ...launch, completionAbortSignal: controller.signal }
      } catch (error) {
        this.controllers.delete(request.run.id)
        throw error
      }
    }
  }

  abortAll(): void {
    for (const controller of this.controllers.values()) {
      controller.abort()
    }
    this.controllers.clear()
  }

  private trackCompletion(
    runId: string,
    controller: AbortController,
    launch: HeadlessAutomationDispatchLaunch
  ): void {
    if (!launch.completion) {
      this.controllers.delete(runId)
      return
    }
    void launch.completion
      .finally(() => {
        if (this.controllers.get(runId) === controller) {
          this.controllers.delete(runId)
        }
      })
      .catch(() => {})
  }
}
