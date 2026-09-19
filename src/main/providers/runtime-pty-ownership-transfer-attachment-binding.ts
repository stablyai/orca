export type RuntimePtyOwnershipTransferAttachmentBinding = Readonly<{
  clientId: number
  transportGeneration?: number
  pairedDeviceId?: string
  isStale: () => boolean
}>

export function requestContext(binding: RuntimePtyOwnershipTransferAttachmentBinding) {
  return {
    clientId: binding.clientId,
    ...(binding.transportGeneration === undefined
      ? {}
      : { transportGeneration: binding.transportGeneration }),
    isStale: binding.isStale
  }
}
