import type { HubDocument } from '../../shared/project-hub-types'
export type ProjectHubApi = {
  read: (projectId: string) => Promise<HubDocument>
  save: (args: { projectId: string; document: HubDocument; expectedRevision: number }) => Promise<HubDocument>
}
