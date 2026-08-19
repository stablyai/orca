export type WorkspaceRuntimeDescriptor = {
  sourceHash: string
  securitySource: string
  mutationSource: string
}

export type LifecycleExtension = {
  source: string
  sourceHash: string
  path: string
  selectedSource: string
  workspaceRuntime: WorkspaceRuntimeDescriptor
}
