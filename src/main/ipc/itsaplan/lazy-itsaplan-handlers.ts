import { registerLazyIpcHandleGroup } from '../lazy-ipc-handle-group'

export const ITSAPLAN_IPC_CHANNELS = [
  'itsaplan:detectApiUrl',
  'itsaplan:connect',
  'itsaplan:disconnect',
  'itsaplan:status',
  'itsaplan:testConnection',
  'itsaplan:listProjects',
  'itsaplan:getProjectMetadata',
  'itsaplan:listIssues',
  'itsaplan:getIssue',
  'itsaplan:createIssue',
  'itsaplan:updateIssue',
  'itsaplan:addComment'
] as const

export function registerLazyItsaplanHandlers(): void {
  registerLazyIpcHandleGroup(ITSAPLAN_IPC_CHANNELS, async (ipc) => {
    const { registerItsaplanHandlers } = await import('./register-handlers')
    registerItsaplanHandlers(ipc)
  })
}
