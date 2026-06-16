import { useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, ExternalLink, FolderPlus, GitBranchPlus, Star } from 'lucide-react'
import { cn } from '../lib/utils'
import { useAppStore } from '../store'
import { isGitRepoKind } from '../../../shared/repo-kind'
import { ShortcutKeyCombo } from './ShortcutKeyCombo'
import { useShortcutKeys } from '@/hooks/useShortcutLabel'
import { useMountedRef } from '@/hooks/useMountedRef'
import logo from '../../../../resources/logo.svg'
import { translate } from '@/i18n/i18n'

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

function getPreflightIssues(status: {
  git: { installed: boolean }
  gh: { installed: boolean; authenticated: boolean }
}): PreflightIssue[] {
  const issues: PreflightIssue[] = []

  if (!status.git.installed) {
    issues.push({
      id: 'git',
      title: translate('auto.components.Landing.e5b7296d9d', 'Git is not installed'),
      description: translate(
        'auto.components.Landing.b673e7cf1b',
        'Git is required for Git projects, source control, and workspace management.'
      ),
      fixLabel: 'Install Git',
      fixUrl: 'https://git-scm.com/downloads'
    })
  }

  if (!status.gh.installed) {
    issues.push({
      id: 'gh',
      title: translate('auto.components.Landing.5beaef5f9e', 'GitHub CLI is not installed'),
      description: translate(
        'auto.components.Landing.73e1ad4282',
        'Orca uses the GitHub CLI (gh) to show pull requests, issues, and checks.'
      ),
      fixLabel: 'Install GitHub CLI',
      fixUrl: 'https://cli.github.com'
    })
  } else if (!status.gh.authenticated) {
    issues.push({
      id: 'gh-auth',
      title: translate('auto.components.Landing.9f96d018b7', 'GitHub CLI is not authenticated'),
      description: translate(
        'auto.components.Landing.00cee697c1',
        'Run "gh auth login" in a terminal to connect your GitHub account.'
      ),
      fixLabel: 'Learn more',
      fixUrl: 'https://cli.github.com/manual/gh_auth_login'
    })
  }

  return issues
}

const ORCA_STARGAZERS_URL = 'https://github.com/stablyai/orca/stargazers'

type StarState = 'loading' | 'starred' | 'not-starred' | 'web-fallback' | 'hidden'

function GitHubStarButton({ hasRepos }: { hasRepos: boolean }): React.JSX.Element | null {
  const [state, setState] = useState<StarState>('loading')
  const [menuOpen, setMenuOpen] = useState(false)
  const wrapperRef = useRef<HTMLDivElement | null>(null)
  const mountedRef = useMountedRef()

  useEffect(() => {
    let cancelled = false
    void window.api.gh.checkOrcaStarred().then((result) => {
      if (cancelled) {
        return
      }
      if (result === null) {
        setState('web-fallback')
      } else {
        setState(result ? 'starred' : 'not-starred')
      }
    })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!menuOpen) {
      return
    }
    const onDocClick = (e: MouseEvent): void => {
      if (!wrapperRef.current?.contains(e.target as Node)) {
        setMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', onDocClick)
    return () => document.removeEventListener('mousedown', onDocClick)
  }, [menuOpen])

  const handleClick = async (): Promise<void> => {
    if (state === 'starred') {
      setMenuOpen((v) => !v)
      return
    }
    if (state === 'web-fallback') {
      await window.api.shell.openUrl(ORCA_STARGAZERS_URL)
      await window.api.starNag.complete()
      return
    }
    if (state !== 'not-starred') {
      return
    }
    setState('starred') // optimistic
    const ok = await window.api.gh.starOrca('landing')
    if (!ok) {
      if (mountedRef.current) {
        setState('web-fallback')
      }
      return
    }
    // Why: starring from any entry point mutes the threshold-based nag.
    // Without this the background notification could still fire on the next
    // threshold crossing, which would feel like a bug to the user.
    await window.api.starNag.complete()
  }

  // Hide once the user has already starred and added a repo.
  if (state === 'hidden' || (state === 'starred' && hasRepos)) {
    return null
  }

  return (
    <div ref={wrapperRef} className="relative inline-block">
      <button
        className={cn(
          'inline-flex items-center gap-2 rounded-full border px-4 py-1.5 text-[13px] font-medium transition-all duration-300',
          state === 'loading' && 'pointer-events-none opacity-0',
          state !== 'starred' &&
            'cursor-pointer border-amber-500/60 text-amber-700 hover:border-amber-500/80 hover:bg-amber-400/10 dark:border-amber-400/30 dark:text-amber-300/90 dark:hover:border-amber-400/50 dark:hover:bg-amber-400/[0.08]',
          state === 'starred' &&
            'cursor-pointer border-amber-500/50 bg-amber-400/10 text-amber-700 dark:border-amber-400/25 dark:bg-amber-400/[0.06] dark:text-amber-400/60'
        )}
        onClick={handleClick}
        disabled={state === 'loading'}
      >
        {state === 'web-fallback' ? (
          <ExternalLink className="size-3.5 text-amber-600 transition-all duration-300 dark:text-amber-400/80" />
        ) : (
          <Star
            className={cn(
              'size-3.5 transition-all duration-300',
              state === 'starred'
                ? 'fill-amber-500/70 text-amber-500/70 dark:fill-amber-400/60 dark:text-amber-400/60'
                : 'text-amber-600 dark:text-amber-400/80'
            )}
          />
        )}
        {state === 'starred'
          ? translate('auto.components.Landing.ec43b38ba7', 'Starred on GitHub')
          : state === 'web-fallback'
            ? translate('auto.components.Landing.157bb5ecbb', 'Open GitHub')
            : translate('auto.components.Landing.0d0ace8861', 'Star on GitHub')}
      </button>
      {state === 'starred' && menuOpen && (
        <div className="absolute right-0 top-[calc(100%+4px)] z-10 min-w-[100px] rounded-md border border-border bg-popover py-1 shadow-md">
          <button
            className="w-full px-3 py-1.5 text-left text-[13px] text-foreground hover:bg-muted"
            onClick={() => {
              setMenuOpen(false)
              setState('hidden')
            }}
          >
            {translate('auto.components.Landing.c1cf168479', 'Hide')}
          </button>
        </div>
      )}
    </div>
  )
}

function PreflightBanner({ issues }: { issues: PreflightIssue[] }): React.JSX.Element {
  return (
    <div className="w-full rounded-lg border border-yellow-500/30 bg-yellow-500/5 p-4 space-y-3">
      <div className="flex items-center gap-2 text-yellow-500">
        <AlertTriangle className="size-4 shrink-0" />
        <span className="text-sm font-medium">
          {translate('auto.components.Landing.ce44fad849', 'Missing dependencies')}
        </span>
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
  const openModal = useAppStore((s) => s.openModal)

  const createTargetLabel =
    repos.length > 0 && repos.every((repo) => isGitRepoKind(repo)) ? 'Worktree' : 'Workspace'
  const canCreateWorktree = repos.length > 0

  const [preflightIssues, setPreflightIssues] = useState<PreflightIssue[]>([])

  useEffect(() => {
    let cancelled = false
    const refreshPreflight = (force = false): void => {
      void window.api.preflight.check(force ? { force: true } : undefined).then((status) => {
        if (cancelled) {
          return
        }
        setPreflightIssues(getPreflightIssues(status))
      })
    }

    // oxlint-disable-next-line react-doctor/no-initialize-state -- Why: preflight status is read from an external IPC probe on mount and focus.
    refreshPreflight()

    // Why: users often install/authenticate gh outside Orca. Re-check when the
    // window becomes active again so the landing warning clears without relaunch.
    const handleWindowActive = (): void => {
      if (document.visibilityState === 'visible') {
        refreshPreflight(true)
      }
    }

    document.addEventListener('visibilitychange', handleWindowActive)
    window.addEventListener('focus', handleWindowActive)

    return () => {
      cancelled = true
      document.removeEventListener('visibilitychange', handleWindowActive)
      window.removeEventListener('focus', handleWindowActive)
    }
  }, [])

  useEffect(() => {
    if (preflightIssues.length === 0) {
      return
    }

    let cancelled = false
    // Why: some users complete `gh auth login` without ever leaving the Orca
    // window. Poll only while a warning is visible so the banner self-clears.
    const intervalId = window.setInterval(() => {
      void window.api.preflight.check({ force: true }).then((status) => {
        if (cancelled) {
          return
        }
        setPreflightIssues(getPreflightIssues(status))
      })
    }, 30000)

    return () => {
      cancelled = true
      window.clearInterval(intervalId)
    }
  }, [preflightIssues.length])

  const createWorktreeKeys = useShortcutKeys('workspace.create')
  const previousWorktreeKeys = useShortcutKeys('worktree.navigateUp')
  const nextWorktreeKeys = useShortcutKeys('worktree.navigateDown')
  const shortcuts = useMemo<ShortcutItem[]>(() => {
    return [
      {
        id: 'create',
        keys: createWorktreeKeys,
        action: `Create ${createTargetLabel.toLowerCase()}`
      },
      { id: 'up', keys: previousWorktreeKeys, action: 'Move up workspace' },
      { id: 'down', keys: nextWorktreeKeys, action: 'Move down workspace' }
    ]
  }, [createTargetLabel, createWorktreeKeys, nextWorktreeKeys, previousWorktreeKeys])

  return (
    <div className="absolute inset-0 flex items-center justify-center bg-background">
      <div className="w-full max-w-lg px-6">
        <div className="flex flex-col items-center gap-4 py-8">
          <div
            className="flex items-center justify-center size-20 rounded-2xl border border-border/80 shadow-lg shadow-black/40"
            style={{ backgroundColor: '#12181e' }}
          >
            <img
              src={logo}
              alt={translate('auto.components.Landing.520304a067', 'Orca logo')}
              className="size-12"
            />
          </div>
          <h1 className="text-4xl font-bold text-foreground tracking-tight">
            {translate('auto.components.Landing.6ca6ff404e', 'ORCA')}
          </h1>

          {preflightIssues.length > 0 && <PreflightBanner issues={preflightIssues} />}

          <p className="text-sm text-muted-foreground text-center">
            {canCreateWorktree
              ? translate(
                  'auto.components.Landing.9c00bd4adf',
                  'Select a workspace from the sidebar to begin.'
                )
              : translate('auto.components.Landing.cd21242762', 'Add a project to get started.')}
          </p>

          <div className="flex items-center justify-center gap-2.5 flex-wrap">
            <button
              className="inline-flex items-center gap-1.5 bg-secondary/70 border border-border/80 text-foreground font-medium text-sm px-4 py-2 rounded-md cursor-pointer hover:bg-accent transition-colors"
              onClick={() => openModal('add-repo')}
            >
              <FolderPlus className="size-3.5" />
              {translate('auto.components.Landing.f9eaa9e12d', 'Add Project')}
            </button>

            <button
              className="inline-flex items-center gap-1.5 bg-secondary/70 border border-border/80 text-foreground font-medium text-sm px-4 py-2 rounded-md transition-colors disabled:opacity-40 disabled:cursor-not-allowed enabled:cursor-pointer enabled:hover:bg-accent"
              disabled={!canCreateWorktree}
              title={
                !canCreateWorktree
                  ? translate('auto.components.Landing.f05d237049', 'Add a project first')
                  : undefined
              }
              onClick={() => openModal('new-workspace-composer', { telemetrySource: 'unknown' })}
            >
              <GitBranchPlus className="size-3.5" />
              {translate('auto.components.Landing.76a95f7f47', 'Create')}
              {createTargetLabel}
            </button>
          </div>

          <div className="mt-6 w-full max-w-xs space-y-2">
            {shortcuts.map((shortcut) => (
              <div key={shortcut.id} className="grid grid-cols-[1fr_auto] items-center gap-3">
                <span className="text-sm text-muted-foreground">{shortcut.action}</span>
                <ShortcutKeyCombo
                  keys={shortcut.keys}
                  separatorClassName="mx-0.5 text-[10px] text-muted-foreground"
                />
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="absolute bottom-6 left-0 right-0 flex justify-center">
        <GitHubStarButton hasRepos={repos.length > 0} />
      </div>
    </div>
  )
}
