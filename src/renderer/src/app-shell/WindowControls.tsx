import { useEffect, useState } from 'react'
import { useTranslate } from '@/i18n/use-translate'

// Windows/Linux replace native chrome with renderer controls.
export function WindowControls(): React.JSX.Element {
  const t = useTranslate()
  const [maximized, setMaximized] = useState(false)
  useEffect(() => {
    // Seed maximization from main; transition events alone miss startup-maximized windows.
    let cancelled = false
    void window.api.ui.isMaximized().then((value) => {
      if (!cancelled) {
        setMaximized(value)
      }
    })
    const unsubscribe = window.api.ui.onMaximizeChanged(setMaximized)
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [])
  return (
    <div className="window-controls">
      <button
        className="window-controls-btn"
        aria-label={t('auto.App.bbb7f90669', 'Minimize')}
        onClick={() => window.api.ui.minimize()}
      >
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
          <path d="M0 5h10v1H0z" fill="currentColor" />
        </svg>
      </button>
      <button
        className="window-controls-btn"
        aria-label={
          maximized ? t('auto.App.66f0a552e5', 'Restore') : t('auto.App.c9d6f98459', 'Maximize')
        }
        onClick={() => window.api.ui.maximize()}
      >
        {maximized ? (
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
            <path d="M2 0v2H0v8h8V8h2V0H2zm6 9H1V3h7v6zM9 7H8V2H3V1h6v6z" fill="currentColor" />
          </svg>
        ) : (
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
            <path d="M0 0v10h10V0H0zm9 9H1V1h8v8z" fill="currentColor" />
          </svg>
        )}
      </button>
      <button
        className="window-controls-btn window-controls-close"
        aria-label={t('auto.App.e960d18540', 'Close')}
        // Request main’s close event so terminal confirmation runs; sandboxed window.close is unreliable.
        onClick={() => window.api.ui.requestClose()}
      >
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
          <path d="M1 0L0 1l4 4-4 4 1 1 4-4 4 4 1-1-4-4 4-4-1-1-4 4-4-4z" fill="currentColor" />
        </svg>
      </button>
    </div>
  )
}
