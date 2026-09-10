export type DurableWorkerMutationIdentity = {
  callerFingerprint: string
  requestId: string
  method: string
  payloadHash: string
}
