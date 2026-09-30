import { LivenessProbeReplyWitness } from './liveness-probe-reply-witness'

const LIVENESS_REQUEST_ID_PREFIX = 'mobile-liveness-'

export class DirectLivenessProbes {
  private readonly replies = new LivenessProbeReplyWitness()

  frame(requestId: string, deviceToken: string) {
    const id = `${LIVENESS_REQUEST_ID_PREFIX}${requestId}`
    this.replies.probeSent(id)
    return { id, deviceToken, method: 'status.get' }
  }

  requestWritten(request: unknown): void {
    this.replies.requestWritten(request)
  }

  /** Calls onSettled when the reply proves the current uplink; returns whether it was a probe reply. */
  observeReply(responseId: string, onSettled: () => void): boolean {
    if (this.replies.settles(responseId)) {
      onSettled()
    }
    return responseId.startsWith(LIVENESS_REQUEST_ID_PREFIX)
  }
}
