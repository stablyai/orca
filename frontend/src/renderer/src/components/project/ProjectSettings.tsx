// ProjectSettings.tsx — Project settings dialog with General/Members/Repos tabs (TDD-FE-12, TASK-FE-004)
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '../ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../ui/dialog'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '../ui/tabs'
import { MemberManager } from './MemberManager'
import { RepoMemberManager } from './RepoMemberManager'
import { LinkedProjectsManager } from './LinkedProjectsManager'
import { ProjectDevServerSection } from './ProjectDevServerSection'
import { ProjectDevServerFilterSection } from './ProjectDevServerFilterSection'
import { ProjectRepoCandidatesSection } from './ProjectRepoCandidatesSection'
import { ProjectMobileEmulatorAgentSection } from './ProjectMobileEmulatorAgentSection'
import { useConfirmationDialog } from '../confirmation-dialog'
import { useWorkspace } from '../../context/WorkspaceContext'
import { useAppStore } from '../../store'
import {
  callRuntimeRpc,
  getActiveRuntimeTarget,
  RuntimeRpcCallError
} from '../../runtime/runtime-rpc-client'
import type { ProjectMember } from '../../types/workspace-types'

// Same FORBIDDEN/UNAUTHENTICATED-message pattern as MemberManager.tsx/ProjectDevServerSection.tsx.
function describeError(err: unknown, fallback: string): string {
  const message = err instanceof RuntimeRpcCallError || err instanceof Error ? err.message : ''
  if (/^FORBIDDEN/i.test(message) || message === 'UNAUTHENTICATED') {
    return 'You do not have permission to do that.'
  }
  return message || fallback
}

type ProjectSettingsProps = {
  projectId: string
  open: boolean
  onClose: () => void
  // Why optional: only ProjectSwitcher (the one caller that owns the project
  // list) needs to react to a delete — it must refetch and switch away from
  // the now-gone project. Tests/other callers can omit it.
  onDeleted?: () => void
}

type RepoListItem = { id: string; displayName: string; url: string }

export function ProjectSettings({ projectId, open, onClose, onDeleted }: ProjectSettingsProps) {
  // Why WorkspaceContext, not `useAppStore(s => s.projects)`: that field is
  // the legacy RepoSlice's own `projects` (multi-host repo grouping, an
  // unrelated concept) — casting it to OrcaProject[] never actually
  // resolved this project's real name. WorkspaceContext.project is the
  // OrcaProject ProjectSwitcher/switchProject actually fetched.
  const { project } = useWorkspace()
  const [activeTab, setActiveTab] = useState('general')
  const [repos, setRepos] = useState<RepoListItem[]>([])
  const [selectedRepoId, setSelectedRepoId] = useState<string | null>(null)
  const [currentUserRole, setCurrentUserRole] = useState<ProjectMember['role'] | null>(null)
  const [deleting, setDeleting] = useState(false)
  const confirm = useConfirmationDialog()
  // Pure client-side filter (no RPC write) — ProjectDevServerFilterSection's
  // selection narrows ProjectRepoCandidatesSection's "repos to add" list
  // below. Empty set = no filter (every dev server's repos are candidates).
  const [selectedDevServerIds, setSelectedDevServerIds] = useState<ReadonlySet<string>>(new Set())

  const loadRepos = (): void => {
    const target = getActiveRuntimeTarget(useAppStore.getState().settings)
    callRuntimeRpc<{ repos: RepoListItem[] }>(target, 'repo.list', { projectId })
      .then((result) => setRepos(result.repos ?? []))
      .catch(() => setRepos([]))
  }

  useEffect(() => {
    if (!open) {
      return
    }
    loadRepos()
    // loadRepos reads projectId via closure — depending on it directly (not
    // the function identity, which is recreated every render) is enough.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, projectId])

  // BUG-FE-PW-002 — the Linked Projects tab needs to know the viewer's own
  // role to decide whether to render the Unlink button. There is no RPC that
  // returns "my own membership row" directly (project.getMember is an
  // internal ProjectService.ts method, not a registered RPC — confirmed via
  // grep, see TASK-FE-PW-002-C), so reuse project.getMembers (already used by
  // MemberManager below) and filter by the signed-in user's id.
  useEffect(() => {
    if (!open) {
      return
    }
    const target = getActiveRuntimeTarget(useAppStore.getState().settings)
    const myUserId = useAppStore.getState().currentUser?.id
    if (!myUserId) {
      setCurrentUserRole(null)
      return
    }
    callRuntimeRpc<ProjectMember[]>(target, 'project.getMembers', { projectId })
      .then((members) => {
        const me = members.find((m) => m.userId === myUserId)
        setCurrentUserRole(me?.role ?? null)
      })
      .catch(() => setCurrentUserRole(null))
  }, [open, projectId])

  // Backend requires owner (or global admin, invisible client-side) —
  // project-service.md §9. Gating the button on project role is a UX
  // shortcut, not the real check: DeleteProject.Execute enforces it again
  // server-side regardless of what this button shows.
  const handleDelete = async (): Promise<void> => {
    const confirmed = await confirm({
      title: 'Delete project?',
      description: `This permanently deletes "${project?.name ?? projectId}" and all its members, repos, and worktree bindings. This cannot be undone.`,
      confirmLabel: 'Delete project',
      confirmVariant: 'destructive'
    })
    if (!confirmed) {
      return
    }
    setDeleting(true)
    try {
      const target = getActiveRuntimeTarget(useAppStore.getState().settings)
      await callRuntimeRpc(target, 'project.delete', { projectId })
      toast.success('Project deleted')
      onDeleted?.()
      onClose()
    } catch (err) {
      toast.error(describeError(err, 'Failed to delete project.'))
    } finally {
      setDeleting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-2xl" data-testid="project-settings-dialog">
        <DialogHeader>
          <DialogTitle>Project Settings — {project?.name ?? projectId}</DialogTitle>
        </DialogHeader>

        <Tabs value={activeTab} onValueChange={setActiveTab}>
          <TabsList>
            <TabsTrigger value="general" data-testid="tab-general">
              General
            </TabsTrigger>
            <TabsTrigger value="members" data-testid="tab-members">
              Members
            </TabsTrigger>
            <TabsTrigger value="repos" data-testid="tab-repos">
              Repos
            </TabsTrigger>
            <TabsTrigger value="linked" data-testid="tab-linked">
              Linked Projects
            </TabsTrigger>
          </TabsList>

          <TabsContent value="general" className="py-4">
            <div className="space-y-6">
              <p className="text-sm text-muted-foreground">
                General project settings (name, description, repository bindings).
              </p>
              {/* TODO: Add name/description form fields in future tasks */}
              <ProjectDevServerFilterSection
                selectedDevServerIds={selectedDevServerIds}
                onChange={setSelectedDevServerIds}
              />
              <ProjectDevServerSection projectId={projectId} />
              <ProjectMobileEmulatorAgentSection projectId={projectId} />
              {currentUserRole === 'owner' ? (
                <div className="space-y-2 border-t border-destructive/30 pt-4">
                  <p className="text-xs font-medium text-destructive">Danger zone</p>
                  <p className="text-xs text-muted-foreground">
                    Deleting a project removes it, its members, repos, and worktree bindings
                    permanently. Blocked while a workflow or task is actively running.
                  </p>
                  <Button
                    type="button"
                    variant="destructive"
                    size="sm"
                    disabled={deleting}
                    onClick={() => void handleDelete()}
                    data-testid="delete-project-button"
                  >
                    {deleting ? 'Deleting…' : 'Delete project'}
                  </Button>
                </div>
              ) : null}
            </div>
          </TabsContent>

          <TabsContent value="members" className="py-2">
            <MemberManager projectId={projectId} />
          </TabsContent>

          <TabsContent value="repos" className="py-2">
            <div className="space-y-5">
              <div className="space-y-2">
                <p className="text-xs font-medium text-foreground">Add a repo</p>
                <p className="text-xs text-muted-foreground">
                  Attach an already-known repo to this project. Use the General tab&apos;s dev
                  server filter to narrow the list below.
                </p>
                <ProjectRepoCandidatesSection
                  projectId={projectId}
                  existingRepoIds={new Set(repos.map((r) => r.id))}
                  selectedDevServerIds={selectedDevServerIds}
                  onAdded={loadRepos}
                />
              </div>

              <div className="space-y-2 border-t pt-4">
                <p className="text-xs font-medium text-foreground">Repo roles</p>
                <p className="text-xs text-muted-foreground">
                  Pick a repo to manage its functional-role grants (developer/lead/admin) — separate
                  from project membership above.
                </p>
                <div className="flex flex-wrap gap-1.5" data-testid="repo-picker">
                  {repos.length === 0 ? (
                    <p className="text-sm text-muted-foreground">No repos in this project yet.</p>
                  ) : (
                    repos.map((r) => (
                      <button
                        key={r.id}
                        type="button"
                        data-testid={`repo-picker-item-${r.id}`}
                        onClick={() => setSelectedRepoId(r.id)}
                        className={`rounded-md border px-2 py-1 text-xs ${
                          selectedRepoId === r.id ? 'border-primary bg-primary/10' : 'border-input'
                        }`}
                      >
                        {r.displayName || r.url}
                      </button>
                    ))
                  )}
                </div>
                {selectedRepoId ? <RepoMemberManager repoId={selectedRepoId} /> : null}
              </div>
            </div>
          </TabsContent>

          <TabsContent value="linked" className="py-2">
            <LinkedProjectsManager orcaProjectId={projectId} currentUserRole={currentUserRole} />
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  )
}
