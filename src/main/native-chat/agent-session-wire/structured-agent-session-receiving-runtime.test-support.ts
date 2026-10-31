import { OrcaRuntimeService } from '../../runtime/orca-runtime'

export class ReceivingRuntime extends OrcaRuntimeService {
  override getOrchestrationDbIfAvailable() {
    return super.getOrchestrationDbIfAvailable()
  }
  mailTarget(handle: string) {
    return this.resolveStructuredMailboxTarget(handle)
  }
}
