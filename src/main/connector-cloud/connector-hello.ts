// What a hello says about this machine, always within the cloud's request cap.
import {
  CONNECTOR_CLIENT_LIMITS,
  CONNECTOR_CONTRACT_VERSION,
  type ConnectorProject
} from '../../shared/connector-cloud-contract'
import type { ConnectorMachine } from './connector-machine'
import { jsonBytes } from './connector-snapshot'

// `reply` is advertised once `orca slack reply` ships.
const FEATURES = ['answer', 'cancel']
const PROMPT_KINDS = ['approval', 'question']
// Only Slack conversations reach this machine's seam so far.
const SOURCES = ['slack']

export type ConnectorHelloSaid = { agents: string[]; projects: ConnectorProject[] }

/** The hello body; projects come most recently used first, so the least recent go when it would not fit. */
export function connectorHello(
  machine: ConnectorMachine,
  said: ConnectorHelloSaid
): { body: unknown; trimmed: boolean } {
  const envelope = {
    v: 1,
    contract: CONNECTOR_CONTRACT_VERSION,
    orcaVersion: machine.orcaVersion,
    platform: process.platform,
    runtime: machine.runtime,
    hostName: machine.hostName,
    agents: said.agents,
    promptKinds: PROMPT_KINDS,
    features: FEATURES,
    sources: SOURCES
  }
  let bytes = jsonBytes({ ...envelope, projects: [] })
  let count = 0
  for (const project of said.projects) {
    // Each project adds its JSON and a comma.
    bytes += jsonBytes(project) + 1
    if (bytes > CONNECTOR_CLIENT_LIMITS.maxRequestBytes) {
      break
    }
    count++
  }
  return {
    body: { ...envelope, projects: said.projects.slice(0, count) },
    trimmed: count < said.projects.length
  }
}
