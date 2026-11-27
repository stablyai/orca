import { expect, it } from 'vitest'
import {
  liveTextViewerKey,
  registerLiveTextViewer,
  setLiveTextViewerShown
} from './structured-agent-session-live-text-viewers'

it('ignores a report older than the last one a stream took, so a late one cannot undo a newer', () => {
  const viewer = liveTextViewerKey('session', 'viewer-0123456789ab')
  const states: boolean[] = []
  const release = registerLiveTextViewer(viewer, 1, (shown) => states.push(shown))
  setLiveTextViewerShown(viewer, false, 2)
  setLiveTextViewerShown(viewer, true, 3)
  // The hide sent before the restore arrives last.
  setLiveTextViewerShown(viewer, false, 2)
  // A report from before this stream opened.
  setLiveTextViewerShown(viewer, false, 1)
  expect(states).toEqual([false, true])
  release()
})
