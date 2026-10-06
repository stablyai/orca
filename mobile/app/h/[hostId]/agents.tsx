import { MobileAgentRosterScreen } from '../../../src/agent-roster/MobileAgentRosterScreen'

// Native-only page: no shell switch, unlike tasks.tsx — this route has nothing to serve in the
// desktop web shell.
export default function MobileAgentsRoute() {
  return <MobileAgentRosterScreen />
}
