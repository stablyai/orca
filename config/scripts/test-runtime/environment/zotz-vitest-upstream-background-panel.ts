// Upstream suites look for a chat's background-tasks strip in the document; Zotz portals it into the
// right sidebar's Background panel, so point that panel at the body for DOM tests.
import { setZotzBackgroundPanelTarget } from '../../../../src/renderer/src/components/zotz/background/zotz-background-panel-target'

if (typeof document !== 'undefined' && document.body) {
  setZotzBackgroundPanelTarget(document.body)
}
