import type { WorkspaceLinkedItem } from '../../shared/worktree/types'
import type { TaskSourceContext } from '../../shared/task-source-context'
import { isWorkspaceLinkedItemSourceContextMatch } from '../../shared/workspace-linked-item-source-context'
import { getLaunchAdmission } from './client'

const pendingPaperclipIssues = new Set<string>()

type PaperclipWorkspaceStore = {
  getAllWorktreeMeta: () => Readonly<
    Record<string, { linkedWorkItem?: WorkspaceLinkedItem | null }>
  >
  getFolderWorkspaces: () => readonly { linkedTask?: WorkspaceLinkedItem | null }[]
}

export async function withPaperclipWorkspaceAdmission<T>(input: {
  linkedWorkItem: WorkspaceLinkedItem | null | undefined
  linkedTaskSourceContext: TaskSourceContext | null | undefined
  store: PaperclipWorkspaceStore
  localTarget: boolean
  create: () => Promise<T> | T
}): Promise<T> {
  const request = getPaperclipAdmissionRequest(input.linkedWorkItem, input.linkedTaskSourceContext)
  if (!request) {
    return input.create()
  }
  if (!input.localTarget) {
    throw new Error('Paperclip-linked workspaces are available only on the local Orca runtime.')
  }
  const key = [request.connectionId, request.companyId, request.projectId, request.issueId].join(
    '\0'
  )
  if (pendingPaperclipIssues.has(key) || hasExistingPaperclipWorkspace(input.store, request)) {
    throw new Error('An Orca workspace is already linked to this Paperclip issue.')
  }
  pendingPaperclipIssues.add(key)
  try {
    const admission = await getLaunchAdmission(request)
    if (!admission.allowed) {
      throw new Error('Paperclip run state changed. Workspace creation stopped.')
    }
    return await input.create()
  } finally {
    pendingPaperclipIssues.delete(key)
  }
}

export function assertNoPaperclipRuntimeLink(
  linkedWorkItem: WorkspaceLinkedItem | null | undefined,
  linkedTaskSourceContext?: TaskSourceContext | null
): void {
  if (
    linkedWorkItem?.provider === 'paperclip' ||
    linkedTaskSourceContext?.provider === 'paperclip'
  ) {
    throw new Error('Paperclip-linked workspaces are not supported over runtime RPC.')
  }
}

function getPaperclipAdmissionRequest(
  linkedWorkItem: WorkspaceLinkedItem | null | undefined,
  linkedTaskSourceContext: TaskSourceContext | null | undefined
): {
  issueId: string
  connectionId: string
  companyId: string
  projectId: string
} | null {
  const hasPaperclipItem = linkedWorkItem?.provider === 'paperclip'
  const hasPaperclipContext = linkedTaskSourceContext?.provider === 'paperclip'
  if (!hasPaperclipItem && !hasPaperclipContext) {
    return null
  }
  if (
    !hasPaperclipItem ||
    !hasPaperclipContext ||
    !isWorkspaceLinkedItemSourceContextMatch(linkedWorkItem, linkedTaskSourceContext)
  ) {
    throw new Error(
      'Paperclip workspace creation requires matching linked item and source context.'
    )
  }
  const issueId = linkedWorkItem.paperclipIssueId?.trim()
  const connectionId = linkedWorkItem.paperclipConnectionId?.trim()
  const companyId = linkedWorkItem.paperclipCompanyId?.trim()
  const projectId = linkedWorkItem.paperclipProjectId?.trim()
  if (!issueId || !connectionId || !companyId || !projectId) {
    throw new Error('The linked Paperclip scope is missing.')
  }
  return { issueId, connectionId, companyId, projectId }
}

function hasExistingPaperclipWorkspace(
  store: PaperclipWorkspaceStore,
  request: { issueId: string; connectionId: string; companyId: string; projectId: string }
): boolean {
  const items = [
    ...Object.values(store.getAllWorktreeMeta()).map((meta) => meta.linkedWorkItem),
    ...store.getFolderWorkspaces().map((workspace) => workspace.linkedTask)
  ]
  return items.some(
    (item) =>
      item?.provider === 'paperclip' &&
      item.paperclipIssueId === request.issueId &&
      item.paperclipConnectionId === request.connectionId &&
      item.paperclipCompanyId === request.companyId &&
      item.paperclipProjectId === request.projectId
  )
}
