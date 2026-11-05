import { useEffect } from 'react'
import {
  readActivePerforceFile,
  runPerforceChordAction
} from '../components/right-sidebar/perforce/perforce-file-chord-actions'
import { PerforceChordDetector } from '../../../shared/perforce/perforce-file-chord'

/** Registers the Alt+P, Alt+E / Alt+R chords for the active Perforce file. */
export function usePerforceFileChords(): void {
  useEffect(() => {
    const detector = new PerforceChordDetector()
    const onKeyDown = (event: KeyboardEvent): void => {
      // Why: cheap pre-check so ordinary typing never reads the store.
      if (!event.altKey) {
        detector.reset()
        return
      }
      const file = readActivePerforceFile()
      const result = detector.process(
        {
          code: event.code,
          alt: event.altKey,
          control: event.ctrlKey,
          meta: event.metaKey,
          shift: event.shiftKey,
          isAutoRepeat: event.repeat
        },
        Date.now(),
        file !== null
      )
      if (!result) {
        return
      }
      event.preventDefault()
      event.stopPropagation()
      if (result.type === 'action' && file) {
        void runPerforceChordAction(result.action, file)
      }
    }
    // Why: capture phase, like the other global shortcuts, so editors and inputs do not swallow the keys first.
    window.addEventListener('keydown', onKeyDown, { capture: true })
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true })
  }, [])
}
