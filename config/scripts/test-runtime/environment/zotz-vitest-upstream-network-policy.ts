// Upstream suites assert Orca's cloud and telemetry behavior; zotz-network-policy-guards.test.ts closes the policy again.
import { _setZotzCloudFeaturesOpenForTests } from '../../../../src/shared/zotz/zotz-network-policy'

_setZotzCloudFeaturesOpenForTests(true)
