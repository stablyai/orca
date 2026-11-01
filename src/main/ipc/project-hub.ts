import { app, ipcMain } from 'electron'
import type { Store } from '../persistence/loading-store/store'
import { getProjectIdentityKey } from '../../shared/project-host-setup-projection'
import { isHubDocument } from '../../shared/project-hub-types'
import { ProjectHubStore } from '../project-hub/project-hub-store'

let trustedWindowId: number | null = null

/** Refresh on desktop window recreation; never retain a stale renderer authority. */
export function setTrustedProjectHubRenderer(id: number | null): void { trustedWindowId = id }

export function registerProjectHubHandlers(store: Store): void {
  const db = new ProjectHubStore(app.getPath('userData'))
  const authorize = (sender: number, projectId: unknown): string => {
    if(trustedWindowId===null || sender!==trustedWindowId) throw new Error('Project Hub requires trusted desktop window')
    if(typeof projectId!=='string'||!projectId||projectId.length>500) throw new Error('Invalid Project.id')
    const known = store.getProjects().some(p=>p.id===projectId) ||
      store.getRepos().some(r=>getProjectIdentityKey(r)===projectId)
    if(!known) throw new Error('Project not registered in Orca')
    return projectId
  }
  ipcMain.handle('projectHub:read',(event,projectId: unknown)=>db.read(authorize(event.sender.id,projectId)))
  ipcMain.handle('projectHub:save',(event,args: unknown)=>{
    if(!args||typeof args!=='object'||Array.isArray(args)) throw new Error('Invalid request')
    const data=args as Record<string,unknown>
    const id=authorize(event.sender.id,data.projectId)
    if(!isHubDocument(data.document)) throw new Error('Invalid document')
    return db.save(id,data.document,data.expectedRevision as number)
  })
}
