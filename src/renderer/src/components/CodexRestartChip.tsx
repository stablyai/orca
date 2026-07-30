import { useEffect, useId, useMemo, useRef } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useAppStore } from '../store'
import { selectCodexRestartInputs } from './codex-restart-chip-inputs'
import { translate } from '@/i18n/i18n'
import { shouldFocusMobileDriverAction } from './terminal-pane/mobile-driver-overlay-focus'
import { buildCodexRestartNoticeKey } from './codex-restart-notice-key'
import { awaitsCodexRestartAnswer } from './codex-restart-notice-state'
import type { CodexRestartNotice } from '../store/slices/terminals'

const EMPTY_TABS: { id: string }[] = []

export function collectStalePtyIdsForTabs({
  tabs,
  ptyIdsByTabId,
  codexRestartNoticeByPtyId
}: {
  tabs: { id: string }[]
  ptyIdsByTabId: Record<string, string[]>
  codexRestartNoticeByPtyId: Record<string, CodexRestartNotice | undefined>
}): string[] {
  // Why: an already-requested restart runs when its pane next mounts. Keeping it
  // out of the prompt is what stops the panel from sticking on a worktree whose
  // stale pane is parked or deferred and cannot answer the request yet. A
  // dismissed notice is likewise answered — it only survives as launch-account
  // memory.
  return tabs.flatMap((tab) =>
    (ptyIdsByTabId[tab.id] ?? []).filter((ptyId) =>
      awaitsCodexRestartAnswer(codexRestartNoticeByPtyId[ptyId])
    )
  )
}

export function collectStaleWorktreePtyIds({
  tabsByWorktree,
  ptyIdsByTabId,
  codexRestartNoticeByPtyId,
  worktreeId
}: {
  tabsByWorktree: Record<string, { id: string }[]>
  ptyIdsByTabId: Record<string, string[]>
  codexRestartNoticeByPtyId: Record<string, CodexRestartNotice | undefined>
  worktreeId: string
}): string[] {
  return collectStalePtyIdsForTabs({
    tabs: tabsByWorktree[worktreeId] ?? EMPTY_TABS,
    ptyIdsByTabId,
    codexRestartNoticeByPtyId
  })
}

export function dismissStaleWorktreePtyIds(
  staleWorktreePtyIds: string[],
  dismissCodexRestartNotices: (ptyIds: string[]) => void,
  forgetLaunchAccounts: (ptyIds: string[]) => void
): void {
  // Why: restart notices are stored per PTY, but the workspace host presents
  // one shared prompt. Dismissing all matching PTY notices keeps every pane in
  // that worktree consistent with the dismissal.
  dismissCodexRestartNotices(staleWorktreePtyIds)
  // Why: notices are renderer-only, so without dropping the on-disk launch
  // record the startup sweep re-raises this exact prompt — and re-blocks the
  // pane's input — after every app restart the user already answered.
  forgetLaunchAccounts(staleWorktreePtyIds)
}

function isInsideHiddenTree(element: HTMLElement): boolean {
  return element.closest('[aria-hidden="true"], [hidden], [inert]') !== null
}

type RestartNotice = {
  previousAccountLabel: string
  nextAccountLabel: string
}

export default function CodexRestartChip({
  isVisible = true,
  worktreeId
}: {
  isVisible?: boolean
  worktreeId: string
}): React.JSX.Element | null {
  const tabs = useAppStore((s) => s.tabsByWorktree[worktreeId] ?? EMPTY_TABS)
  // Why: both of these maps churn on unrelated pty lifecycle events (ptyIdsByTabId
  // on attach/detach; codexRestartNoticeByPtyId is re-spread even when empty on
  // pty teardown), so subscribe to them only while a restart notice actually
  // exists. Otherwise this per-worktree chip re-rendered on every pty event to
  // compute "no notice → render nothing". See codex-restart-chip-inputs.
  const { ptyIdsByTabId, codexRestartNoticeByPtyId } = useAppStore(
    useShallow(selectCodexRestartInputs)
  )
  const staleWorktreePtyIds = useMemo(
    () =>
      collectStalePtyIdsForTabs({
        tabs,
        ptyIdsByTabId,
        codexRestartNoticeByPtyId
      }),
    [codexRestartNoticeByPtyId, ptyIdsByTabId, tabs]
  )
  const restartNotice = staleWorktreePtyIds[0]
    ? codexRestartNoticeByPtyId[staleWorktreePtyIds[0]]
    : undefined
  const queueCodexPaneRestarts = useAppStore((s) => s.queueCodexPaneRestarts)
  const dismissCodexRestartNotices = useAppStore((s) => s.dismissCodexRestartNotices)

  const noticeKey = restartNotice ? buildCodexRestartNoticeKey(restartNotice) : null

  if (staleWorktreePtyIds.length === 0 || !restartNotice) {
    return null
  }

  const handleRestart = (): void => {
    queueCodexPaneRestarts(staleWorktreePtyIds)
  }

  const handleDismiss = (): void => {
    dismissStaleWorktreePtyIds(staleWorktreePtyIds, dismissCodexRestartNotices, (ptyIds) => {
      void window.api.codexAccounts.forgetStalePanes({ ptyIds }).catch((err: unknown) => {
        console.warn('Failed to forget dismissed Codex pane accounts:', err)
      })
    })
  }

  return (
    <LoudRestartOverlay
      isVisible={isVisible}
      noticeKey={noticeKey}
      restartNotice={restartNotice}
      onDismiss={handleDismiss}
      onRestart={handleRestart}
    />
  )
}

function LoudRestartOverlay({
  isVisible,
  noticeKey,
  restartNotice,
  onDismiss,
  onRestart
}: {
  isVisible: boolean
  noticeKey: string | null
  restartNotice: RestartNotice
  onDismiss: () => void
  onRestart: () => void
}): React.JSX.Element {
  const titleId = useId()
  const bodyId = useId()
  const rootRef = useRef<HTMLDivElement>(null)

  // Why: move focus to the card only when the user isn't typing elsewhere;
  // unconditional autoFocus would steal keys from an active composer.
  //
  // The target is the dialog itself, never Restart. This card is mounted per
  // WORKTREE (a sibling of the split layout), so its focus scope is every
  // terminal in the worktree — a notice for one pane lands while the user may
  // be typing in a different, perfectly healthy pane. With Restart focused, the
  // next Space/Enter of their prose queued a restart of every stale pane here
  // and destroyed those sessions. Focus must not land on a destructive action
  // the user never aimed at. See #10863.
  useEffect(() => {
    if (!isVisible) {
      return
    }
    const root = rootRef.current
    if (!root || isInsideHiddenTree(root)) {
      return
    }
    const paneScope = root.parentElement
    if (shouldFocusMobileDriverAction(document.activeElement, document.body, paneScope)) {
      root.focus()
    }
  }, [isVisible, noticeKey])

  return (
    <div
      ref={rootRef}
      role="dialog"
      // Why: programmatically focusable so the card can take focus itself, but
      // out of the Tab order — Tab from here still reaches Restart/Keep.
      tabIndex={-1}
      aria-live="assertive"
      aria-labelledby={titleId}
      aria-describedby={bodyId}
      className="pointer-events-none absolute inset-0 z-50 flex items-center justify-center p-6 outline-none"
    >
      <div className="pointer-events-auto flex w-full max-w-[30rem] flex-col gap-3 rounded-lg border border-border bg-card p-6 pb-5 text-card-foreground shadow-xs">
        <div className="flex items-start gap-3">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-full border border-border bg-muted">
            <RefreshCw className="size-5 text-foreground" aria-hidden="true" />
          </div>
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <div className="text-xs font-medium uppercase tracking-wide text-foreground">
              {translate('auto.components.CodexRestartChip.d3e8a1f4b2', 'Account switched')}
            </div>
            <div id={titleId} className="text-base font-semibold leading-tight">
              {translate(
                'auto.components.CodexRestartChip.a4c8e1b2f7',
                'Codex is still signed in as {{value0}}',
                { value0: restartNotice.previousAccountLabel }
              )}
            </div>
          </div>
        </div>
        <div id={bodyId} className="text-sm leading-relaxed text-muted-foreground">
          {translate(
            'auto.components.CodexRestartChip.9375620cc3',
            'Restart this session to use {{value0}}. It stays on the previous account until you do.',
            { value0: restartNotice.nextAccountLabel }
          )}
        </div>
        <div className="mt-1 flex flex-wrap justify-end gap-2">
          <Button type="button" variant="outline" size="sm" onClick={onDismiss}>
            {translate('auto.components.CodexRestartChip.6133594b12', 'Keep old account')}
          </Button>
          <Button type="button" variant="default" size="sm" onClick={onRestart}>
            <RefreshCw />
            {translate('auto.components.CodexRestartChip.c72a5fb234', 'Restart')}
          </Button>
        </div>
      </div>
    </div>
  )
}
