// This host's Microsoft Teams connector: the one sign-in kept here, the device code sign-ins a client
// starts, and the Graph calls the verbs make. Only the client that started a sign-in sees or ends it.
import type {
  TeamsAccountView,
  TeamsSignInPrompt,
  TeamsSignInStatus
} from '../../shared/teams/teams-connect-types'
import { CallerOwnedSignInFlows } from '../runtime/caller-owned-sign-in-flows'
import { teamsGraph, type TeamsGraph } from './teams-graph'
import {
  readTeamsAccount,
  removeTeamsAccount,
  type TeamsAccountRecord
} from './teams-credential-store'
import {
  defaultTeamsSignInDeps,
  runTeamsDeviceSignIn,
  type TeamsSignInDeps,
  type TeamsSignInInput
} from './teams-device-sign-in'

// Microsoft's codes last 15 minutes; the extra minute covers the last poll.
const OWNER_SILENCE_MS = 16 * 60_000

export function teamsAccountView(record: TeamsAccountRecord): TeamsAccountView {
  return {
    name: record.name,
    email: record.email,
    tenantId: record.tenantId,
    clientId: record.clientId,
    status: record.status,
    ...(record.reason ? { reason: record.reason } : {}),
    channels: record.channels,
    grantedScopes: record.grantedScopes,
    connectedAt: record.connectedAt
  }
}

export class TeamsConnect {
  private readonly flows: CallerOwnedSignInFlows<
    'teams',
    TeamsSignInPrompt,
    never,
    { account: TeamsAccountView },
    TeamsSignInInput
  >
  readonly graph: TeamsGraph

  constructor(private readonly deps: TeamsSignInDeps = defaultTeamsSignInDeps) {
    this.graph = teamsGraph(deps)
    this.flows = new CallerOwnedSignInFlows(
      async (_provider, channel, input) => {
        if (!input) {
          throw new Error('The Microsoft sign-in did not start.')
        }
        return { account: teamsAccountView(await runTeamsDeviceSignIn(this.deps, input, channel)) }
      },
      {
        acceptsPrompt: () => true,
        // Nothing comes back to type here: the person enters the code on Microsoft's page.
        acceptsCode: () => false,
        describeFailure: (message) => ({ error: message.slice(0, 600) }),
        busyMessage:
          'A Microsoft Teams sign-in is already running on this computer. Finish or cancel it first.',
        startKey: (input) =>
          input ? `${input.tenantId}:${input.clientId}:${input.channels}` : undefined,
        ownerSilenceMs: OWNER_SILENCE_MS
      }
    )
  }

  async account(): Promise<TeamsAccountView | null> {
    const record = await readTeamsAccount()
    return record ? teamsAccountView(record) : null
  }

  startSignIn(owner: string, input: TeamsSignInInput): TeamsSignInStatus {
    return toWire(this.flows.start(owner, 'teams', input))
  }

  async waitSignIn(
    owner: string,
    flowId: string,
    afterRevision: number,
    signal?: AbortSignal
  ): Promise<TeamsSignInStatus> {
    return toWire(await this.flows.wait(owner, flowId, afterRevision, signal))
  }

  async cancelSignIn(owner: string, flowId: string): Promise<TeamsSignInStatus> {
    return toWire(await this.flows.cancel(owner, flowId))
  }

  /** Forgets the sign-in here. Microsoft keeps the consent until it is removed at myapps.microsoft.com. */
  async disconnect(): Promise<{ removed: string | null }> {
    const record = await readTeamsAccount()
    await removeTeamsAccount()
    return { removed: record ? (record.email ?? record.name) : null }
  }
}

function toWire(status: {
  flowId: string
  revision: number
  phase: TeamsSignInStatus['phase']
  prompt?: TeamsSignInPrompt
  error?: string
  account?: TeamsAccountView
}): TeamsSignInStatus {
  return {
    flowId: status.flowId,
    revision: status.revision,
    phase: status.phase,
    ...(status.prompt ? { prompt: status.prompt } : {}),
    ...(status.error ? { error: status.error } : {}),
    ...(status.account ? { account: status.account } : {})
  }
}

let shared: TeamsConnect | null = null

/** One per host process, made on first use; nothing runs until someone connects. */
export function getTeamsConnect(): TeamsConnect {
  shared ??= new TeamsConnect()
  return shared
}
