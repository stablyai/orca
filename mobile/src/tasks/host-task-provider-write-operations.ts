export type HostTaskProviderWriteOperations = {
  createIssue(payload: {
    provider: 'github' | 'gitlab'
    repoId: string
    title: string
    body: string
  }): Promise<{ number?: number; url?: string }>
  updateIssueSource(repoId: string, preference: 'upstream' | 'origin'): Promise<void>
}
