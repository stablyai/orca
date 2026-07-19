import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useAppStore } from '../store'
import { selectCodexRestartInputs } from './codex-restart-chip-inputs'
import { translate } from '@/i18n/i18n'
import { shouldFocusMobileDriverAction } from './terminal-pane/mobile-driver-overlay-focus'
import {
  buildCodexRestartNoticeKey,
  createCodexRestartOverlayCollapseState,
  getCodexRestartOverlayCollapseState
} from './codex-restart-overlay-collapse'

const EMPTY_TABS: { id: string }[] = []

export function collectStalePtyIdsForTabs({
  tabs,
  ptyIdsByTabId,
  codexRestartNoticeByPtyId
}: {
  tabs: { id: string }[]
  ptyIdsByTabId: Record<string, string[]>
  codexRestartNoticeByPtyId: Record<string, unknown>
}): string[] {
  return tabs.flatMap((tab) =>
    (ptyIdsByTabId[tab.id] ?? []).filter((ptyId) => Boolean(codexRestartNoticeByPtyId[ptyId]))
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
  codexRestartNoticeByPtyId: Record<string, unknown>
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
  clearCodexRestartNotice: (ptyId: string) => void
): void {
  // Why: restart notices are stored per PTY, but the workspace host presents
  // one shared prompt. Clearing all matching PTY notices keeps every pane in
  // that worktree consistent with the dismissal.
  for (const ptyId of staleWorktreePtyIds) {
    clearCodexRestartNotice(ptyId)
  }
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
  const clearCodexRestartNotice = useAppStore((s) => s.clearCodexRestartNotice)

  const noticeKey = restartNotice ? buildCodexRestartNoticeKey(restartNotice) : null
  const [collapseState, setCollapseState] = useState(() =>
    createCodexRestartOverlayCollapseState(noticeKey)
  )

  const currentCollapseState = getCodexRestartOverlayCollapseState(collapseState, noticeKey)
  useEffect(() => {
    // Why: a new account switch must reopen loud mode without updating state
    // during render, which can trip React's external-store snapshot guard.
    setCollapseState((state) => getCodexRestartOverlayCollapseState(state, noticeKey))
  }, [noticeKey])

  if (staleWorktreePtyIds.length === 0 || !restartNotice) {
    return null
  }

  const handleRestart = (): void => {
    queueCodexPaneRestarts(staleWorktreePtyIds)
  }

  const handleDismiss = (): void => {
    dismissStaleWorktreePtyIds(staleWorktreePtyIds, clearCodexRestartNotice)
  }

  if (currentCollapseState.collapsed) {
    return (
      <CollapsedRestartChip
        restartNotice={restartNotice}
        onExpand={() => setCollapseState(createCodexRestartOverlayCollapseState(noticeKey))}
        onRestart={handleRestart}
      />
    )
  }

  return (
    <LoudRestartOverlay
      isVisible={isVisible}
      noticeKey={noticeKey}
      restartNotice={restartNotice}
      onCollapse={() => setCollapseState({ noticeKey, collapsed: true })}
      onDismiss={handleDismiss}
      onRestart={handleRestart}
    />
  )
}

function LoudRestartOverlay({
  isVisible,
  noticeKey,
  restartNotice,
  onCollapse,
  onDismiss,
  onRestart
}: {
  isVisible: boolean
  noticeKey: string | null
  restartNotice: RestartNotice
  onCollapse: () => void
  onDismiss: () => void
  onRestart: () => void
}): React.JSX.Element {
  const titleId = useId()
  const bodyId = useId()
  const rootRef = useRef<HTMLDivElement>(null)
  const restartRef = useRef<HTMLButtonElement>(null)

  // Why: focus Restart only when the user isn't typing elsewhere; unconditional
  // autoFocus would steal keys from an active composer or terminal input.
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
      restartRef.current?.focus()
    }
  }, [isVisible, noticeKey])

  return (
    <div
      ref={rootRef}
      role="dialog"
      aria-live="assertive"
      aria-labelledby={titleId}
      aria-describedby={bodyId}
      className="pointer-events-none absolute inset-0 z-50 flex items-center justify-center p-6"
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
          <Button type="button" variant="outline" size="sm" onClick={onCollapse}>
            {translate('auto.components.CodexRestartChip.b9000fe511', 'Not now')}
          </Button>
          <Button ref={restartRef} type="button" variant="default" size="sm" onClick={onRestart}>
            <RefreshCw />
            {translate('auto.components.CodexRestartChip.c72a5fb234', 'Restart')}
          </Button>
        </div>
      </div>
    </div>
  )
}

function CollapsedRestartChip({
  restartNotice,
  onExpand,
  onRestart
}: {
  restartNotice: RestartNotice
  onExpand: () => void
  onRestart: () => void
}): React.JSX.Element {
  return (
    <div
      className="absolute right-2 top-2 z-50 flex max-w-[min(100%-1rem,24rem)] items-center gap-1.5 rounded-full border border-border bg-card px-2 py-1 text-xs font-medium text-card-foreground shadow-xs"
      role="status"
      aria-live="polite"
    >
      <RefreshCw className="size-3 shrink-0 text-foreground" aria-hidden="true" />
      <Button
        type="button"
        variant="ghost"
        size="xs"
        className="min-w-0 max-w-[10rem] px-1 font-medium"
        onClick={onExpand}
      >
        <span className="truncate">
          {translate(
            'auto.components.CodexRestartChip.a4c8e1b2f7',
            'Codex is still signed in as {{value0}}',
            { value0: restartNotice.previousAccountLabel }
          )}
        </span>
      </Button>
      <Button type="button" variant="default" size="xs" onClick={onRestart}>
        {translate('auto.components.CodexRestartChip.c72a5fb234', 'Restart')}
      </Button>
    </div>
  )
}
