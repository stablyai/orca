const LIVENESS_REQUEST_ID_PREFIX = 'mobile-liveness-'

export function directLivenessProbeFrame(requestId: string, deviceToken: string) {
  return { id: `${LIVENESS_REQUEST_ID_PREFIX}${requestId}`, deviceToken, method: 'status.get' }
}

export function isDirectLivenessProbeReply(responseId: string): boolean {
  return responseId.startsWith(LIVENESS_REQUEST_ID_PREFIX)
}
