export class SkillRemoteInstallCancellation {
  private readonly operations = new Map<string, AbortController>()

  begin(operationId: string): AbortSignal {
    if (this.operations.has(operationId)) {
      throw new Error('skill-install-operation-in-progress')
    }
    const controller = new AbortController()
    this.operations.set(operationId, controller)
    return controller.signal
  }

  finish(operationId: string, signal: AbortSignal): void {
    if (this.operations.get(operationId)?.signal === signal) {
      this.operations.delete(operationId)
    }
  }

  cancel(operationId: string): boolean {
    const controller = this.operations.get(operationId)
    controller?.abort()
    return Boolean(controller)
  }
}
