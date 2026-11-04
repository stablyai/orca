import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { writeSecureFile } from '../../shared/secure-file'
import { emptyProjectHub, isHubDocument, hasHubPhaseEvidence, type HubDocument } from '../../shared/project-hub-types'

const LIMIT = 512 * 1024
export function hubFilePath(root: string, projectId: string): string {
  if (!projectId || projectId.length>500) throw new Error('Invalid Orca Project.id')
  return join(root,'project-hub','v1',createHash('sha256').update(projectId).digest('hex')+'.json')
}
export class ProjectHubStore {
  constructor(private readonly userData: string) {}
  read(projectId: string): HubDocument {
    const file=hubFilePath(this.userData,projectId)
    let bytes: number
    try { bytes=statSync(file).size }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code==='ENOENT') return emptyProjectHub(projectId)
      throw error // EACCES/EPERM are not proof the document is absent.
    }
    if(bytes>LIMIT) throw new Error('Project Hub document too large')
    const data: unknown = JSON.parse(readFileSync(file,'utf8'))
    if(!isHubDocument(data)||data.projectId!==projectId)
      throw new Error('Invalid/cross-project Project Hub document: refusing overwrite')
    return data
  }
  save(projectId: string, incoming: HubDocument, expectedRevision: number): HubDocument {
    if(!isHubDocument(incoming)||incoming.projectId!==projectId) throw new Error('Invalid Project Hub document')
    const prev=this.read(projectId)
    if(!Number.isSafeInteger(expectedRevision)||prev.revision!==expectedRevision||incoming.revision!==expectedRevision)
      throw new Error('Conflict: reload Project Hub before saving')
    // Approvals are append-only; phase changes require a gate and one matching record.
    if (JSON.stringify(incoming.approvals.slice(0,prev.approvals.length))!==JSON.stringify(prev.approvals))
      throw new Error('Approval history cannot be rewritten')
    // Once a phase is approved, its evidence is locked to that audit record.
    const locked=new Set(prev.approvals.map(a=>a.from))
    const before=prev.qualityEvidence??{}
    const after=incoming.qualityEvidence??{}
    for(const key of new Set([...Object.keys(before),...Object.keys(after)])) {
      const phase=Number(key.split(':')[0])
      if(locked.has(phase)&&JSON.stringify(before[key])!==JSON.stringify(after[key]))
        throw new Error('Approved QA evidence cannot be rewritten')
    }
    if (incoming.phase===prev.phase) {
      if (incoming.approvals.length!==prev.approvals.length) throw new Error('Unexpected approval record')
    } else if (incoming.phase===prev.phase+1) {
      const last=incoming.approvals[prev.approvals.length]
      if (incoming.approvals.length!==prev.approvals.length+1 || !last ||
          last.from!==prev.phase || last.to!==incoming.phase ||
          !hasHubPhaseEvidence({...incoming,phase:prev.phase}))
        throw new Error('Phase transition requires matching approval and QA evidence')
    } else throw new Error('Phase cannot skip or move backwards')
    const next: HubDocument={...incoming,revision:prev.revision+1,updatedAt:new Date().toISOString()}
    const text=JSON.stringify(next,null,2)
    if(Buffer.byteLength(text,'utf8')>LIMIT) throw new Error('Project Hub document too large')
    if(!writeSecureFile(hubFilePath(this.userData,projectId),text,{durable:true}))
      throw new Error('Unable to secure Project Hub data for this user')
    return next
  }
}
