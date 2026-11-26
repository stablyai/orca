import type { ConnectorCloudStatus } from '../../shared/bots/connector-cloud-status'
import type { ConnectorCloudFeature } from '../../shared/connectors/connector-cloud-contract'

/** What the bot list says about the connector's most recent hello and sign-in. */
export function connectorBotListFacts(
  features: ReadonlySet<string> | null,
  connectorStatus: ConnectorCloudStatus,
  needsSignIn: boolean,
  refusal: string | null
) {
  return {
    threadReplies: features?.has('triggers.inThread' satisfies ConnectorCloudFeature) === true,
    githubEvents2: features?.has('triggers.github2' satisfies ConnectorCloudFeature) === true,
    githubWorkflows: features?.has('triggers.workflows' satisfies ConnectorCloudFeature) === true,
    githubCiFinished:
      features?.has('triggers.ci_finished' satisfies ConnectorCloudFeature) === true,
    connectorStatus,
    ...((connectorStatus === 'refused' || connectorStatus === 'needs-sign-in') && refusal
      ? { connectorMessage: refusal }
      : {}),
    ...(needsSignIn || connectorStatus === 'needs-sign-in'
      ? { connectorNeedsSignIn: true as const }
      : {})
  }
}
