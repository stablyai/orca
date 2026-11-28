import { Activity, Suspense, useCallback, useState } from 'react'
import { lazyWithRetry as lazy } from '@/app-shell/startup/lazy-with-retry'
import { usePreloadAfterInputQuiet } from '@/app-shell/startup/use-preload-after-input-quiet'
import { useTranslate } from '@/i18n/use-translate'
import { useAppStore } from '@/store/index'
import { RecoverableRenderErrorBoundary } from '../components/error-boundaries/RecoverableRenderErrorBoundary'

const TaskPage = lazy(() => import('../components/task-page/TaskPage'))

/** With preloading on, Tasks is built after startup and kept while hidden; Activity pauses its effects (Esc, polling, fetches) off-screen. */
export function TaskPageMount({ active }: { active: boolean }): React.JSX.Element | null {
  const t = useTranslate()
  const preload = useAppStore((s) => s.settings?.preloadTaskPage === true)
  const repoId = useAppStore((s) => s.taskPageData.preselectedRepoId) ?? null
  const [warm, setWarm] = useState(false)
  const warmUp = useCallback(() => setWarm(true), [])
  usePreloadAfterInputQuiet(warmUp, preload)
  // The kept page's remount key and the repo it was seeded with; null while nothing is kept.
  const [kept, setKept] = useState<{ key: number; repoId: string | null } | null>(null)
  const [wasActive, setWasActive] = useState(active)
  if (active !== wasActive) {
    setWasActive(active)
    // Why: repo selection is seeded only at mount, so opening into or out of a repo-scoped view starts fresh, as it does unpreloaded.
    if (active && kept && (repoId || kept.repoId)) {
      setKept({ key: kept.key + 1, repoId })
    }
  }

  if (!preload || (!active && !warm)) {
    if (kept) {
      setKept(null)
    }
    return !preload && active ? <TaskPage /> : null
  }
  // An open before the scheduled warm-up still keeps the page once it is left.
  if (!warm) {
    setWarm(true)
  }
  if (!kept) {
    setKept({ key: 0, repoId })
  }
  return (
    <Activity mode={active ? 'visible' : 'hidden'}>
      {/* Own boundaries so a hidden render error or chunk load cannot replace the visible page. */}
      <RecoverableRenderErrorBoundary
        boundaryId="page.tasks.preloaded"
        surface="page"
        title={t('auto.App.b7a714db1e', 'This page hit an error.')}
        description={t(
          'auto.App.03a14f6b5b',
          'Retry the page or navigate to another Orca surface.'
        )}
      >
        <Suspense fallback={null}>
          <TaskPage key={kept?.key ?? 0} />
        </Suspense>
      </RecoverableRenderErrorBoundary>
    </Activity>
  )
}
