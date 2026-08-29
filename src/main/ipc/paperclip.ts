import { ipcMain } from 'electron'
import type { PaperclipLaunchAdmissionRequest } from '../../shared/paperclip-types'
import {
  connect,
  disconnect,
  getIssue,
  getLaunchAdmission,
  getStatus,
  listIssues,
  testConnection
} from '../paperclip/client'

export function registerPaperclipHandlers(): void {
  ipcMain.handle(
    'paperclip:connectLocalTrusted',
    async (_event, args: { origin?: string; companyId?: string; projectId?: string }) => {
      if (
        typeof args?.origin !== 'string' ||
        typeof args?.companyId !== 'string' ||
        typeof args?.projectId !== 'string'
      ) {
        return { ok: false, error: 'Paperclip connection details are required.' }
      }
      // No credential or credential handle crosses IPC. Authenticated deployments
      // need a separate main-process credential-capture design.
      return connect({
        origin: args.origin,
        companyId: args.companyId,
        projectId: args.projectId
      })
    }
  )
  ipcMain.handle('paperclip:disconnect', () => disconnect())
  ipcMain.handle('paperclip:status', () => getStatus())
  ipcMain.handle('paperclip:testConnection', () => testConnection())
  ipcMain.handle('paperclip:listIssues', (_event, args?: { query?: string }) =>
    listIssues(typeof args?.query === 'string' ? args.query : undefined)
  )
  ipcMain.handle('paperclip:getIssue', (_event, args: { issueId?: string }) => {
    const issueId = normalizeId(args?.issueId)
    if (!issueId) {
      throw new Error('A Paperclip issue ID is required.')
    }
    return getIssue(issueId)
  })
  ipcMain.handle(
    'paperclip:getLaunchAdmission',
    (_event, args: PaperclipLaunchAdmissionRequest) => {
      const request = normalizeAdmissionRequest(args)
      if (!request) {
        throw new Error('A Paperclip issue ID is required.')
      }
      return getLaunchAdmission(request)
    }
  )
}

function normalizeAdmissionRequest(value: unknown): PaperclipLaunchAdmissionRequest | null {
  if (!value || typeof value !== 'object') {
    return null
  }
  const args = value as Record<string, unknown>
  const issueId = normalizeId(args.issueId)
  const connectionId = normalizeId(args.connectionId)
  const companyId = normalizeId(args.companyId)
  const projectId = normalizeId(args.projectId)
  return issueId && connectionId && companyId && projectId
    ? { issueId, connectionId, companyId, projectId }
    : null
}

function normalizeId(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}
