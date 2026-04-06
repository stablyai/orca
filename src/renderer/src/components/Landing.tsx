import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, ExternalLink, FolderPlus, GitBranchPlus } from 'lucide-react'
import { useAppStore } from '../store'
import logo from '../../../../resources/logo.svg'

type ShortcutItem = {
  id: string
  keys: string[]
  action: string
}

type PreflightIssue = {
  id: string
  title: string
  description: string
  fixLabel: string
  fixUrl: string
}

function KeyCap({ label }: { label: string }): React.JSX.Element {
  return (
    <span className="inline-flex min-w-6 items-center justify-center rounded border border-border/80 bg-secondary/70 px-1.5 py-0.5 text-[10px] font-semibold text-muted-foreground">
      {label}
    </span>
  )
}

function PreflightBanner({ issues }: { issues: PreflightIssue[] }): React.JSX.Element {
  return (
    <div className="w-full rounded-lg border border-yellow-500/30 bg-yellow-500/5 p-4 space-y-3">
      <div className="flex items-center gap-2 text-yellow-500">
        <AlertTriangle className="size-4 shrink-0" />
        <span className="text-sm font-medium">Missing dependencies</span>
      </div>
      <div className="space-y-2.5">
        {issues.map((issue) => (
          <div key={issue.id} className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-sm font-medium text-foreground">{issue.title}</p>
              <p className="text-xs text-muted-foreground mt-0.5">{issue.description}</p>
            </div>
            <button
              className="inline-flex items-center gap-1 shrink-0 text-xs font-medium text-blue-400 hover:text-blue-300 transition-colors cursor-pointer"
              onClick={() => window.api.shell.openUrl(issue.fixUrl)}
            >
              {issue.fixLabel}
              <ExternalLink className="size-3" />
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}

export default function Landing(): React.JSX.Element {
  const repos = useAppStore((s) => s.repos)
  const addRepo = useAppStore((s) => s.addRepo)
  const openModal = useAppStore((s) => s.openModal)

  const canCreateWorktree = repos.length > 0

  const [preflightIssues, setPreflightIssues] = useState<PreflightIssue[]>([])

  useEffect(() => {
    let cancelled = false

    void window.api.preflight.check().then((status) => {
      if (cancelled) {
        return
      }

      const issues: PreflightIssue[] = []

      if (!status.git.installed) {
        issues.push({
          id: 'git',
          title: 'Git is not installed',
          description: 'Orca requires Git to manage repositories and worktrees.',
          fixLabel: 'Install Git',
          fixUrl: 'https://git-scm.com/downloads'
        })
      }

      if (!status.gh.installed) {
        issues.push({
          id: 'gh',
          title: 'GitHub CLI is not installed',
          description: 'Orca uses the GitHub CLI (gh) to show pull requests, issues, and checks.',
          fixLabel: 'Install GitHub CLI',
          fixUrl: 'https://cli.github.com'
        })
      } else if (!status.gh.authenticated) {
        issues.push({
          id: 'gh-auth',
          title: 'GitHub CLI is not authenticated',
          description: 'Run "gh auth login" in a terminal to connect your GitHub account.',
          fixLabel: 'Learn more',
          fixUrl: 'https://cli.github.com/manual/gh_auth_login'
        })
      }

      setPreflightIssues(issues)
    })

    return () => {
      cancelled = true
    }
  }, [])

  const shortcuts = useMemo<ShortcutItem[]>(
    () => [
      { id: 'create', keys: ['⌘', 'N'], action: 'Create worktree' },
      { id: 'up', keys: ['⌘', '⇧', '↑'], action: 'Move up worktree' },
      { id: 'down', keys: ['⌘', '⇧', '↓'], action: 'Move down worktree' }
    ],
    []
  )

  return (
    <div className="absolute inset-0 flex items-center justify-center bg-background">
      <div className="w-full max-w-lg px-6">
        <div className="flex flex-col items-center gap-4 py-8">
          <div
            className="flex items-center justify-center size-20 rounded-2xl border border-border/80 shadow-lg shadow-black/40"
            style={{ backgroundColor: '#12181e' }}
          >
            <img src={logo} alt="Orca logo" className="size-12" />
          </div>
          <h1 className="text-4xl font-bold text-foreground tracking-tight">ORCA</h1>

          {preflightIssues.length > 0 && <PreflightBanner issues={preflightIssues} />}

          <p className="text-sm text-muted-foreground text-center">
            {canCreateWorktree
              ? 'Select a worktree from the sidebar to begin.'
              : 'Add a repository to get started.'}
          </p>

          <div className="flex items-center justify-center gap-2.5 flex-wrap">
            <button
              className="inline-flex items-center gap-1.5 bg-secondary/70 border border-border/80 text-foreground font-medium text-sm px-4 py-2 rounded-md cursor-pointer hover:bg-accent transition-colors"
              onClick={addRepo}
            >
              <FolderPlus className="size-3.5" />
              Add Repo
            </button>

            <button
              className="inline-flex items-center gap-1.5 bg-secondary/70 border border-border/80 text-foreground font-medium text-sm px-4 py-2 rounded-md transition-colors disabled:opacity-40 disabled:cursor-not-allowed enabled:cursor-pointer enabled:hover:bg-accent"
              disabled={!canCreateWorktree}
              title={!canCreateWorktree ? 'Add a repo first' : undefined}
              onClick={() => openModal('create-worktree')}
            >
              <GitBranchPlus className="size-3.5" />
              Create Worktree
            </button>
          </div>

          <div className="mt-6 w-full max-w-xs space-y-2">
            {shortcuts.map((shortcut) => (
              <div key={shortcut.id} className="grid grid-cols-[1fr_auto] items-center gap-3">
                <span className="text-sm text-muted-foreground">{shortcut.action}</span>
                <div className="flex items-center gap-1">
                  {shortcut.keys.map((key) => (
                    <KeyCap key={`${shortcut.id}-${key}`} label={key} />
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
