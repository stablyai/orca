export type RemoteWorkspaceTabObservationAuthority = {
  processId: number
  rendererGeneration: number
  senderId: number
}

export type RemoteWorkspaceUntrackedIntentFence = {
  authority: RemoteWorkspaceTabObservationAuthority
  sequence: number
}

export type RemoteWorkspacePatchIntentCapture = {
  fullSnapshot: boolean
  sequences: Map<string, number>
  untracked: RemoteWorkspaceUntrackedIntentFence | null
}
