import { useEffect, useId, useRef } from 'react'
import { RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useAppStore } from '../store'
import { translate } from '@/i18n/i18n'
import { shouldFocusMobileDriverAction } from './terminal-pane/mobile-driver-overlay-focus'
import { buildCodexRestartNoticeKey } from './codex-restart-notice-key'
import { awaitsCodexRestartAnswer } from './codex-restart-notice-state'

function isInsideHiddenTree(element: HTMLElement): boolean {
  return element.closest('[aria-hidden="true"], [hidden], [inert]') !== null
}

type RestartNotice = {
  previousAccountLabel: string
  nextAccountLabel: string
  homeRouteChanged?: true
}

export default function CodexRestartChip({
  isVisible = true,
  ptyId,
  shouldFocus = false
}: {
  isVisible?: boolean
  ptyId: string
  shouldFocus?: boolean
}): React.JSX.Element | null {
  // Why: one O(1) selector per mounted pane stays idle when unrelated PTY maps
  // churn and prevents a worktree-wide scan for every split pane.
  const restartNotice = useAppStore((state) => state.codexRestartNoticeByPtyId[ptyId])
  if (!restartNotice || !awaitsCodexRestartAnswer(restartNotice)) {
    return null
  }

  const handleRestart = (): void => {
    useAppStore.getState().queueCodexPaneRestarts([ptyId])
  }

  const handleDismiss = (): void => {
    useAppStore.getState().dismissCodexRestartNotices([ptyId])
    // Why: notices are renderer-only, so the persisted launch record must be
    // cleared for this pane or the startup sweep re-raises its answered prompt.
    void window.api.codexAccounts.forgetStalePanes({ ptyIds: [ptyId] }).catch((err: unknown) => {
      console.warn('Failed to forget dismissed Codex pane account:', err)
    })
  }

  return (
    <LoudRestartOverlay
      isVisible={isVisible}
      noticeKey={`${ptyId}:${buildCodexRestartNoticeKey(restartNotice)}`}
      restartNotice={restartNotice}
      shouldFocus={shouldFocus}
      onDismiss={handleDismiss}
      onRestart={handleRestart}
    />
  )
}

function LoudRestartOverlay({
  isVisible,
  noticeKey,
  restartNotice,
  shouldFocus,
  onDismiss,
  onRestart
}: {
  isVisible: boolean
  noticeKey: string | null
  restartNotice: RestartNotice
  shouldFocus: boolean
  onDismiss: () => void
  onRestart: () => void
}): React.JSX.Element {
  const titleId = useId()
  const bodyId = useId()
  const rootRef = useRef<HTMLDivElement>(null)

  // Why: move focus to the card only when the user isn't typing elsewhere;
  // unconditional autoFocus would steal keys from an active composer.
  //
  // The target is the dialog itself, never Restart, so the next Space/Enter
  // cannot destroy a session the user did not explicitly choose. See #10863.
  useEffect(() => {
    if (!isVisible || !shouldFocus) {
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
  }, [isVisible, noticeKey, shouldFocus])

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
              {restartNotice.homeRouteChanged
                ? translate('auto.components.CodexRestartChip.8f0d5c92a1', 'Codex setup changed')
                : translate('auto.components.CodexRestartChip.d3e8a1f4b2', 'Account switched')}
            </div>
            <div id={titleId} className="text-base font-semibold leading-tight">
              {restartNotice.homeRouteChanged
                ? translate(
                    'auto.components.CodexRestartChip.3ea91b5c07',
                    'This Codex session is using an outdated configuration'
                  )
                : translate(
                    'auto.components.CodexRestartChip.a4c8e1b2f7',
                    'Codex is still signed in as {{value0}}',
                    { value0: restartNotice.previousAccountLabel }
                  )}
            </div>
          </div>
        </div>
        <div id={bodyId} className="text-sm leading-relaxed text-muted-foreground">
          {restartNotice.homeRouteChanged
            ? translate(
                'auto.components.CodexRestartChip.e6b7139d2a',
                'Restart this session to load your current Codex configuration.'
              )
            : translate(
                'auto.components.CodexRestartChip.9375620cc3',
                'Restart this session to use {{value0}}. It stays on the previous account until you do.',
                { value0: restartNotice.nextAccountLabel }
              )}
        </div>
        <div className="mt-1 flex flex-wrap justify-end gap-2">
          <Button type="button" variant="outline" size="sm" onClick={onDismiss}>
            {restartNotice.homeRouteChanged
              ? translate('auto.components.CodexRestartChip.7b1d20f4c8', 'Keep current session')
              : translate('auto.components.CodexRestartChip.6133594b12', 'Keep old account')}
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
