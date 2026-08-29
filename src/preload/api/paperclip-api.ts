import type {
  PaperclipConnectionStatus,
  PaperclipConnectionSummary,
  PaperclipIssue,
  PaperclipLaunchAdmission,
  PaperclipLaunchAdmissionRequest
} from '../../shared/paperclip-types'

export type PaperclipApi = {
  connectLocalTrusted: (args: {
    origin: string
    companyId: string
    projectId: string
  }) => Promise<{ ok: true; connection: PaperclipConnectionSummary } | { ok: false; error: string }>
  disconnect: () => Promise<void>
  status: () => Promise<PaperclipConnectionStatus>
  testConnection: () => Promise<{ ok: true } | { ok: false; error: string }>
  listIssues: (args?: { query?: string }) => Promise<PaperclipIssue[]>
  getIssue: (args: { issueId: string }) => Promise<PaperclipIssue>
  getLaunchAdmission: (args: PaperclipLaunchAdmissionRequest) => Promise<PaperclipLaunchAdmission>
}
