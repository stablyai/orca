// Host-wide singleton launch boundary. Admission bounds (256 host / 64 principal
// / 192 remote) are host-scoped, not per-profile, so one boundary — with one
// admission store and one coordinator — serves every launch surface. U4 attaches
// durable persistence; U3 uses the in-memory boundary.

import { AgentLaunchBoundary } from './agent-launch-boundary'
import {
  AgentLaunchAdmissionStore,
  LaunchAdmissionCoordinator
} from './agent-launch-admission-store'

let boundary: AgentLaunchBoundary | null = null

export function getHostAgentLaunchBoundary(): AgentLaunchBoundary {
  if (!boundary) {
    boundary = new AgentLaunchBoundary({
      admissionStore: new AgentLaunchAdmissionStore(),
      coordinator: new LaunchAdmissionCoordinator()
    })
  }
  return boundary
}
