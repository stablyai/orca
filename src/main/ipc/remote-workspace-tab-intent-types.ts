export type RemoteWorkspaceTabObservationAuthority = {
  processId: number
  rendererGeneration: number
  senderId: number
}

export type RemoteWorkspacePatchIntentCapture = {
  fullSnapshot: boolean
  sequences: Map<string, number>
  untracked: boolean
}
