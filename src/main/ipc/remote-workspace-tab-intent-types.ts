export type RemoteWorkspaceTabObservationAuthority = {
  processId: number
  rendererGeneration: number
  senderId: number
}

export type RemoteWorkspaceUntrackedIntentFence = {
  authority: RemoteWorkspaceTabObservationAuthority
  sequence: number
}

export type RemoteWorkspaceTrackedIntentFence = {
  authority: RemoteWorkspaceTabObservationAuthority
  lifecycle: number
}

export type RemoteWorkspacePatchIntentCapture = {
  fullSnapshot: boolean
  sequences: Map<string, number>
  tracked: RemoteWorkspaceTrackedIntentFence | null
  untracked: RemoteWorkspaceUntrackedIntentFence | null
}
