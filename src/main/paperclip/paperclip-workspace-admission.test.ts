import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkspaceLinkedItem } from '../../shared/worktree/types'

const { getLaunchAdmission } = vi.hoisted(() => ({ getLaunchAdmission: vi.fn() }))
vi.mock('./client', () => ({ getLaunchAdmission }))

import {
  assertNoPaperclipRuntimeLink,
  withPaperclipWorkspaceAdmission
} from './paperclip-workspace-admission'

const linkedWorkItem: WorkspaceLinkedItem = {
  provider: 'paperclip',
  type: 'issue',
  number: 0,
  title: 'Paperclip issue',
  url: 'http://127.0.0.1:3100/issues/issue-1',
  paperclipIssueId: 'issue-1',
  paperclipIdentifier: 'PAP-1',
  paperclipConnectionId: 'connection-1',
  paperclipCompanyId: 'company-1',
  paperclipProjectId: 'project-1'
}
const linkedTaskSourceContext = {
  kind: 'task-source' as const,
  provider: 'paperclip' as const,
  projectId: 'project-1',
  hostId: 'local' as const,
  providerIdentity: {
    provider: 'paperclip' as const,
    connectionId: 'connection-1',
    companyId: 'company-1',
    projectId: 'project-1'
  }
}

const emptyStore = () => ({ getAllWorktreeMeta: () => ({}), getFolderWorkspaces: () => [] })

describe('Paperclip workspace mutation boundary', () => {
  beforeEach(() => {
    getLaunchAdmission.mockReset()
    getLaunchAdmission.mockResolvedValue({
      allowed: true,
      requiresNonExclusiveConfirmation: true
    })
  })

  it('performs a fresh admission immediately before local creation', async () => {
    const create = vi.fn(() => 'created')
    await expect(
      withPaperclipWorkspaceAdmission({
        linkedWorkItem,
        linkedTaskSourceContext,
        store: emptyStore(),
        localTarget: true,
        create
      })
    ).resolves.toBe('created')
    expect(getLaunchAdmission).toHaveBeenCalledWith({
      issueId: 'issue-1',
      connectionId: 'connection-1',
      companyId: 'company-1',
      projectId: 'project-1'
    })
    expect(create).toHaveBeenCalledOnce()
  })

  it('rejects nonlocal targets before admission or mutation', async () => {
    const create = vi.fn()
    await expect(
      withPaperclipWorkspaceAdmission({
        linkedWorkItem,
        linkedTaskSourceContext,
        store: emptyStore(),
        localTarget: false,
        create
      })
    ).rejects.toThrow('only on the local Orca runtime')
    expect(getLaunchAdmission).not.toHaveBeenCalled()
    expect(create).not.toHaveBeenCalled()
  })

  it('rejects existing and concurrent duplicate workspace creation', async () => {
    const existingStore = {
      getAllWorktreeMeta: () => ({ existing: { linkedWorkItem } }),
      getFolderWorkspaces: () => []
    }
    await expect(
      withPaperclipWorkspaceAdmission({
        linkedWorkItem,
        linkedTaskSourceContext,
        store: existingStore,
        localTarget: true,
        create: vi.fn()
      })
    ).rejects.toThrow('already linked')

    let finish!: () => void
    const first = withPaperclipWorkspaceAdmission({
      linkedWorkItem,
      linkedTaskSourceContext,
      store: emptyStore(),
      localTarget: true,
      create: () => new Promise<void>((resolve) => (finish = resolve))
    })
    await vi.waitFor(() => expect(getLaunchAdmission).toHaveBeenCalledOnce())
    await expect(
      withPaperclipWorkspaceAdmission({
        linkedWorkItem,
        linkedTaskSourceContext,
        store: emptyStore(),
        localTarget: true,
        create: vi.fn()
      })
    ).rejects.toThrow('already linked')
    finish()
    await first
  })

  it('rejects Paperclip linkage on runtime RPC boundaries', () => {
    expect(() => assertNoPaperclipRuntimeLink(linkedWorkItem, linkedTaskSourceContext)).toThrow(
      'runtime RPC'
    )
    expect(() => assertNoPaperclipRuntimeLink(null, linkedTaskSourceContext)).toThrow('runtime RPC')
  })

  it('requires the Paperclip item and context pair before local creation', async () => {
    await expect(
      withPaperclipWorkspaceAdmission({
        linkedWorkItem,
        linkedTaskSourceContext: null,
        store: emptyStore(),
        localTarget: true,
        create: vi.fn()
      })
    ).rejects.toThrow('matching linked item and source context')
  })
})
