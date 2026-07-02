import { useEffect, useState } from 'react'
import { Cpu, X } from 'lucide-react'
import { Card } from './ui/card'
import { Button } from './ui/button'
import { translate } from '@/i18n/i18n'

// Canonical download page; picks the right architecture for the visitor.
const DOWNLOAD_URL = 'https://onorca.dev/download'

/**
 * One-time nudge shown when Orca is the Intel build running under Rosetta 2 on
 * Apple Silicon. Why: binary translation makes the whole app severely laggy and
 * users rarely realize they installed the wrong dmg. Detection is main-owned and
 * static for the session, so the card fetches once on mount and self-gates.
 */
export function ArchAdvisoryCard() {
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    let cancelled = false
    void window.api.app.getArchAdvisory().then((advisory) => {
      if (!cancelled && advisory.translated && !advisory.dismissed) {
        setVisible(true)
      }
    })
    return () => {
      cancelled = true
    }
  }, [])

  if (!visible) {
    return null
  }

  const handleDismiss = () => {
    // Optimistically hide; persistence is best-effort and must not block the UI.
    setVisible(false)
    void window.api.app.dismissArchAdvisory()
  }

  const title = translate('auto.components.ArchAdvisoryCard.title', 'Running the Intel build')

  return (
    <div
      className="fixed bottom-10 right-4 z-40 w-[360px] max-w-[calc(100vw-32px)]
      max-[480px]:left-4 max-[480px]:right-4 max-[480px]:w-auto"
    >
      <Card role="complementary" aria-label={title} aria-live="polite" className="py-0 gap-0">
        <div className="flex flex-col gap-2.5 p-3.5">
          <div className="flex items-start justify-between gap-2">
            <div className="flex min-w-0 items-center gap-2">
              <Cpu className="size-4 shrink-0 text-muted-foreground" />
              <h3 className="text-sm font-semibold">{title}</h3>
            </div>
            <Button
              variant="ghost"
              size="icon"
              className="size-7 shrink-0 -m-1"
              onClick={handleDismiss}
              aria-label={translate('auto.components.ArchAdvisoryCard.dismiss', 'Dismiss')}
            >
              <X className="size-3.5" />
            </Button>
          </div>

          <p className="text-sm text-muted-foreground">
            {translate(
              'auto.components.ArchAdvisoryCard.body',
              'Orca is running the Intel build under Rosetta on your Apple Silicon Mac, which makes everything noticeably slower. Download the Apple Silicon build for full-speed performance.'
            )}
          </p>

          <Button
            variant="default"
            size="sm"
            className="mt-0.5 w-full cursor-pointer"
            onClick={() => void window.api.shell.openUrl(DOWNLOAD_URL)}
          >
            {translate('auto.components.ArchAdvisoryCard.download', 'Download Apple Silicon build')}
          </Button>
        </div>
      </Card>
    </div>
  )
}
