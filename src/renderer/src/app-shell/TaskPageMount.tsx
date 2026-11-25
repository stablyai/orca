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
  // Why: repo selection is seeded only at mount, so a repo-scoped open needs a fresh page.
  const preselectedRepoId = useAppStore((s) => s.taskPageData.preselectedRepoId)
  const [warm, setWarm] = useState(false)
  const warmUp = useCallback(() => setWarm(true), [])
  usePreloadAfterInputQuiet(warmUp, preload)

  if (!preload) {
    return active ? <TaskPage /> : null
  }
  // An open before the scheduled warm-up still keeps the page once it is left.
  if (active && !warm) {
    setWarm(true)
  }
  if (!active && !warm) {
    return null
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
          <TaskPage key={preselectedRepoId ?? ''} />
        </Suspense>
      </RecoverableRenderErrorBoundary>
    </Activity>
  )
}
