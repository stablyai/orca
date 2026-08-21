import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, ExternalLink, FolderPlus, GitBranchPlus, X } from 'lucide-react'
import { cn } from '../lib/utils'
import { useAppStore } from '../store'
import { isGitRepoKind } from '../../../shared/repo-kind'
import type { Repo } from '../../../shared/repo-types'
import {
  dismissPreflightIssue,
  githubProjectKeys,
  isPreflightIssueDismissed
} from './landing-preflight-dismissal'
import { ShortcutKeyCombo } from './ShortcutKeyCombo'
import { useShortcutKeyDetails, type ShortcutKeyComboDetails } from '@/hooks/useShortcutLabel'
import logo from '../../../../resources/logo.svg'
import { translate } from '@/i18n/i18n'
import type { PreflightIssue } from './landing-preflight-issues'
import { useLandingPreflightRuntime } from './landing-preflight-runtime'

type ShortcutItem = {
  id: string
  shortcut: ShortcutKeyComboDetails
  action: string
}

function PreflightBanner({
  issues,
  repos
}: {
  issues: PreflightIssue[]
  repos: readonly Repo[]
}): React.JSX.Element | null {
  // Why: keying the seed on the current GitHub project set means adding a new
  // GitHub project (which changes the key) re-evaluates dismissals, so a lapsed
  // dismissal re-surfaces the nudge without a manual reset.
  const githubKey = githubProjectKeys(repos).join('|')
  const [dismissed, setDismissed] = useState<Set<string>>(
    () =>
      new Set(
        issues
          .filter((issue) => issue.dismissible && isPreflightIssueDismissed(issue.id, repos))
          .map((issue) => issue.id)
      )
  )

  useEffect(() => {
    setDismissed(
      new Set(
        issues
          .filter((issue) => issue.dismissible && isPreflightIssueDismissed(issue.id, repos))
          .map((issue) => issue.id)
      )
    )
    // Why: re-seed only when the GitHub project set changes; issues identity is
    // stable per render and would otherwise reset transient dismiss state.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [githubKey])

  const visibleIssues = issues.filter((issue) => !dismissed.has(issue.id))
  if (visibleIssues.length === 0) {
    return null
  }

  const dismiss = (issue: PreflightIssue): void => {
    dismissPreflightIssue(issue.id, repos)
    setDismissed((prev) => new Set(prev).add(issue.id))
  }

  return (
    // Why: cap width below the max-w-lg column so the card reads as part of the
    // centered content stack instead of stretching edge-to-edge. The styleguide
    // reserves color for true error state — these are soft setup nudges, so use
    // the quiet muted/border surface, not an amber frame.
    <div className="w-full max-w-sm space-y-1.5 rounded-lg border border-border bg-muted/40 p-3">
      {visibleIssues.map((issue) => (
        <div
          key={issue.id}
          className="flex items-start gap-3 rounded-md px-1 py-1.5 first:pt-0 last:pb-0"
        >
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-500/70" />
          <div className="min-w-0 flex-1 space-y-0.5">
            <p className="text-[13px] font-medium leading-snug text-foreground">{issue.title}</p>
            <p className="text-xs leading-snug text-muted-foreground">{issue.description}</p>
            <button
              className="mt-1 inline-flex items-center gap-1 text-xs font-medium text-primary underline-offset-4 hover:underline cursor-pointer"
              onClick={() => window.api.shell.openUrl(issue.fixUrl)}
            >
              {issue.fixLabel}
              <ExternalLink className="size-3" />
            </button>
          </div>
          {issue.dismissible && (
            <button
              className="-mr-1 -mt-0.5 shrink-0 rounded p-1 text-muted-foreground/70 transition-colors hover:bg-accent hover:text-foreground cursor-pointer"
              onClick={() => dismiss(issue)}
              aria-label={translate('auto.components.Landing.preflightDismiss', 'Dismiss')}
            >
              <X className="size-3.5" />
            </button>
          )}
        </div>
      ))}
    </div>
  )
}

export default function Landing(): React.JSX.Element {
  const repos = useAppStore((s) => s.repos)
  const openModal = useAppStore((s) => s.openModal)

  const createTargetLabel =
    repos.length > 0 && repos.every((repo) => isGitRepoKind(repo)) ? 'Worktree' : 'Workspace'
  const hasProjects = repos.length > 0

  // Why: the runtime-aware slice probes the active remote host instead of the renderer host.
  const { preflightIssues } = useLandingPreflightRuntime()

  const createWorktreeShortcut = useShortcutKeyDetails('workspace.create')
  const previousWorktreeShortcut = useShortcutKeyDetails('worktree.navigateUp')
  const nextWorktreeShortcut = useShortcutKeyDetails('worktree.navigateDown')
  const shortcuts = useMemo<ShortcutItem[]>(() => {
    return [
      {
        id: 'create',
        shortcut: createWorktreeShortcut,
        action: `Create ${createTargetLabel.toLowerCase()}`
      },
      { id: 'up', shortcut: previousWorktreeShortcut, action: 'Move up workspace' },
      { id: 'down', shortcut: nextWorktreeShortcut, action: 'Move down workspace' }
    ]
  }, [createTargetLabel, createWorktreeShortcut, nextWorktreeShortcut, previousWorktreeShortcut])

  return (
    <div className="absolute inset-0 overflow-hidden bg-background">
      {/* Bench field: calibrated graticule, faded toward the center so the
        content column stays clean. Measurement-surface use only. */}
      <div
        aria-hidden
        className="graticule pointer-events-none absolute inset-0 [mask-image:radial-gradient(ellipse_70%_65%_at_50%_42%,transparent_25%,black_100%)]"
      />
      <div className="relative flex h-full items-center justify-center px-6">
        <div className="w-full max-w-xl pb-10">
          <div className="flex flex-col items-center gap-7 py-10 text-center">
            <div
              className="flex size-14 items-center justify-center rounded-xl border border-border bg-card shadow-lg shadow-black/20"
              style={{ backgroundColor: '#12181e' }}
            >
              <img
                src={logo}
                alt={translate('auto.components.Landing.520304a067', 'MCode logo')}
                className="size-9"
              />
            </div>

            <h1 className="max-w-md text-balance text-[2.75rem] font-semibold leading-[1.08] tracking-tight text-foreground">
              {translate('auto.components.Landing.headline', 'Every agent. One bench.')}
            </h1>

            {preflightIssues.length > 0 && (
              <PreflightBanner issues={preflightIssues} repos={repos} />
            )}

            <p className="max-w-sm text-balance text-[15px] leading-relaxed text-muted-foreground">
              {hasProjects
                ? translate(
                    'auto.components.Landing.9c00bd4adf',
                    'Select a workspace from the sidebar to begin.'
                  )
                : translate(
                    'auto.components.Landing.cd21242762',
                    'Add a project to get started.'
                  )}
            </p>

            <div className="flex items-center justify-center gap-2.5">
              <button
                className="inline-flex h-10 cursor-pointer items-center gap-2 rounded-md bg-primary px-5 text-sm font-medium text-primary-foreground shadow-sm transition-colors hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                onClick={() => openModal('new-workspace-composer', { telemetrySource: 'unknown' })}
              >
                <GitBranchPlus className="size-4" />
                Create {createTargetLabel.toLowerCase()}
              </button>
              <button
                className="inline-flex h-10 cursor-pointer items-center gap-2 rounded-md border border-border text-foreground text-sm font-medium px-4 transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                onClick={() => openModal('add-repo')}
              >
                <FolderPlus className="size-4" />
                {translate('auto.components.Landing.f9eaa9e12d', 'Add Project')}
              </button>
            </div>

            <div className="mt-1 flex items-center justify-center">
              {shortcuts.map((shortcut, index) => (
                <div
                  key={shortcut.id}
                  className={cn(
                    'flex items-center gap-2.5 px-5',
                    index > 0 && 'border-l border-border'
                  )}
                >
                  <span className="whitespace-nowrap text-xs text-muted-foreground">
                    {shortcut.action}
                  </span>
                  <ShortcutKeyCombo
                    keys={shortcut.shortcut.keys}
                    doubleTap={shortcut.shortcut.doubleTap}
                    separatorClassName="mx-0.5 text-[10px] text-muted-foreground"
                  />
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Test Bench: GitHub-star footer removed by owner request. */}
    </div>
  )
}
