// ProjectSwitcher.tsx — Command-palette style project selector (TDD-FE-12)
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { useWorkspace } from '../../context/WorkspaceContext'
import { useAppStore } from '../../store'
import { callRuntimeRpc, getActiveRuntimeTarget } from '../../runtime/runtime-rpc-client'
import { Check, ChevronsUpDown, Loader2, Plus, Settings } from 'lucide-react'
import { Button } from '../ui/button'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator
} from '../ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'
import { cn } from '../../lib/utils'
import { CreateProjectDialog } from './CreateProjectDialog'
import { ProjectSettings } from './ProjectSettings'
import type { OrcaProject, Repo } from '../../types/workspace-types'

// project.list's wscompat handler returns the full Project proto message —
// this is a narrower view of the same OrcaProject shape for the picker list.
type OrcaProjectListItem = Pick<OrcaProject, 'id' | 'name' | 'devServerId'>

type DevServerOption = { id: string; name: string }

export function ProjectSwitcher() {
  const { project, switchProject, isInitializing } = useWorkspace()
  const [projects, setProjects] = useState<OrcaProjectListItem[]>([])
  // Why: devServerId is a raw uuid (infra.dev_servers.id), not a display
  // label — was rendered verbatim in the list (looked like "showing IDs
  // instead of names"). Resolve it to devServer.list's own human label
  // (e.g. "dev-01") the same way ProjectDevServerSection already does.
  const [devServerNames, setDevServerNames] = useState<Record<string, string>>({})
  // Phase 10 (project.repos.dev_server_id): a project can now genuinely span
  // repos on different hosts, so `p.devServerId` alone is no longer
  // trustworthy as "the" host once a project has more than one repo.
  // project.list has no repo-count/host field to key off of (adding one is
  // backend-go scope, out of reach here) — the row-level devServerId badge
  // stays keyed off it for the common 0/1-repo case, and this map records an
  // override per project once its repo.list resolves: a devServerId string
  // when 2+ repos share one host, or `null` to suppress the badge entirely
  // when they don't (or share none). Projects not present here (still
  // loading, or the fetch failed) fall back to the legacy `p.devServerId`.
  const [multiRepoDevServerOverride, setMultiRepoDevServerOverride] = useState<
    Record<string, string | null>
  >({})
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [createOpen, setCreateOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)

  const refetchProjects = () => {
    const target = getActiveRuntimeTarget(useAppStore.getState().settings)
    return callRuntimeRpc<OrcaProjectListItem[]>(target, 'project.list', null)
      .then((list) => {
        const resolved = list ?? []
        setProjects(resolved)
        return resolved
      })
      .catch(() => {
        setProjects([])
        return []
      })
  }

  // `useAppStore`'s `projects` field is session-grant string[], not OrcaProject[] —
  // fetch the real OrcaProject list from the backend instead of reading that field.
  useEffect(() => {
    const target = getActiveRuntimeTarget(useAppStore.getState().settings)
    void refetchProjects().then((list) => {
      // Bounded by how many OrcaProjects the caller belongs to (small, and
      // fetched once here rather than per keystroke/render) — acceptable
      // fan-out for a picker list, unlike doing this per row on every render.
      void Promise.all(
        list.map((p) =>
          callRuntimeRpc<{ repos: Repo[] }>(target, 'repo.list', { projectId: p.id })
            .then((result) => ({ projectId: p.id, repos: result?.repos ?? [] }))
            .catch(() => ({ projectId: p.id, repos: [] as Repo[] }))
        )
      ).then((results) => {
        const overrides: Record<string, string | null> = {}
        for (const { projectId, repos } of results) {
          if (repos.length <= 1) {
            continue // ambiguous-free case — the legacy p.devServerId fallback already covers it
          }
          const hostIds = new Set(repos.map((r) => r.devServerId || ''))
          overrides[projectId] = hostIds.size === 1 ? [...hostIds][0] || null : null
        }
        setMultiRepoDevServerOverride(overrides)
      })
    })
    callRuntimeRpc<DevServerOption[]>(target, 'devServer.list', null)
      .then((list) =>
        setDevServerNames(Object.fromEntries((list ?? []).map((d) => [d.id, d.name])))
      )
      .catch(() => setDevServerNames({}))
  }, [])

  const filtered = projects.filter((p) => p.name.toLowerCase().includes(search.toLowerCase()))

  return (
    <div className="flex items-center gap-1">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            role="combobox"
            aria-expanded={open}
            disabled={isInitializing}
            data-testid="project-switcher-trigger"
            className="w-52 justify-between"
          >
            {isInitializing ? (
              <Loader2 className="animate-spin" size={16} />
            ) : (
              <span className="truncate">{project?.name ?? 'Select Project'}</span>
            )}
            <ChevronsUpDown size={14} className="ml-auto opacity-50 shrink-0" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-72 p-0" align="start">
          {/* shouldFilter=false: this component already filters `filtered` by
              p.name (below) — cmdk's own default filter matches against
              CommandItem's value (p.id, a uuid), which can hide/reorder rows
              whose id doesn't fuzzy-match a name-based query. */}
          <Command shouldFilter={false}>
            <CommandInput
              placeholder="Search projects..."
              value={search}
              onValueChange={setSearch}
            />
            <CommandList>
              <CommandEmpty>No projects found</CommandEmpty>
              <CommandGroup>
                {filtered.map((p) => {
                  // Present in the override map => a 2+-repo project whose
                  // repos we've already resolved (a shared host id, or null
                  // for "don't show, hosts differ/unknown"). Absent => still
                  // loading or a 0/1-repo project, where p.devServerId alone
                  // is unambiguous and safe to show as-is.
                  const badgeDevServerId =
                    p.id in multiRepoDevServerOverride
                      ? multiRepoDevServerOverride[p.id]
                      : p.devServerId
                  return (
                    <CommandItem
                      key={p.id}
                      value={p.id}
                      onSelect={() => {
                        switchProject(p.id)
                        setOpen(false)
                      }}
                    >
                      <Check
                        className={cn(
                          'mr-2 shrink-0',
                          p.id === project?.id ? 'opacity-100' : 'opacity-0'
                        )}
                        size={14}
                      />
                      <span className="truncate">{p.name}</span>
                      {badgeDevServerId && (
                        <span className="ml-auto text-xs text-muted-foreground shrink-0">
                          {devServerNames[badgeDevServerId] ?? badgeDevServerId}
                        </span>
                      )}
                    </CommandItem>
                  )
                })}
              </CommandGroup>
              <CommandSeparator />
              <CommandItem
                data-testid="create-project-item"
                onSelect={() => {
                  setOpen(false)
                  setCreateOpen(true)
                }}
              >
                <Plus size={14} className="mr-2" />
                Create New Project
              </CommandItem>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      <Button
        variant="ghost"
        size="icon"
        disabled={!project}
        onClick={() => setSettingsOpen(true)}
        data-testid="project-settings-trigger"
        aria-label="Project settings"
      >
        <Settings size={14} />
      </Button>
      <CreateProjectDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={(created) => {
          void refetchProjects()
          // Why: the project row is already created at this point — a
          // failure here is only "couldn't switch to it yet", not "project
          // creation failed" — so surface it as a toast instead of letting
          // it fall out as a silent unhandled promise rejection (the
          // reported symptom before this catch existed).
          switchProject(created.id).catch(() => {
            toast.error('Project created, but could not switch to it. Select it from the list.')
          })
        }}
      />
      {/* Why built-but-never-mounted before: ProjectSettings/MemberManager
          existed fully wired to real RPCs, but nothing in the app ever
          rendered a trigger to open them. */}
      {project ? (
        <ProjectSettings
          projectId={project.id}
          open={settingsOpen}
          onClose={() => setSettingsOpen(false)}
          onDeleted={() => {
            // The just-deleted project is gone from WorkspaceContext's own
            // state (it only clears on switchProject) — refetch the list and
            // hop to whatever's left, same as CreateProjectDialog's onCreated.
            void refetchProjects().then((list) => {
              if (list.length > 0) {
                switchProject(list[0].id).catch(() => {
                  toast.error('Project deleted, but could not switch away from it.')
                })
              }
            })
          }}
        />
      ) : null}
    </div>
  )
}
