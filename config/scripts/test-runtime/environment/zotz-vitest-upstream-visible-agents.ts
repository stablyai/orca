// Upstream suites assume every catalog agent is visible; zotz-visible-agents.test.ts hides them again.
import { _setZotzAllTuiAgentsVisibleForTests } from '../../../../src/shared/zotz/zotz-visible-agents'

_setZotzAllTuiAgentsVisibleForTests(true)
