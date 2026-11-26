// What bots.list says of the host's Orca Cloud: its link, and what it takes from its last hello
// answer (all false before one).
import type { ConnectorCloudStatus } from '../../shared/bots/connector-cloud-status'
import {
  CONNECTOR_CLOUD_SLACK_CHANNEL_HELLO_FEATURE,
  type ConnectorCloudFeature
} from '../../shared/connector-cloud-features'

export function connectorCloudFeatureFacts(features: ReadonlySet<string> | null): {
  githubEvents2: boolean
  githubWorkflows: boolean
  githubCiFinished: boolean
  slackChannelHello: boolean
} {
  const has = (feature: string): boolean => features?.has(feature) === true
  return {
    // Whether it sends GitHub's newer events and label=, so trigger-options offers only those it does.
    githubEvents2: has('triggers.github2' satisfies ConnectorCloudFeature),
    // Whether it sends github.workflow_finished, so trigger-options offers it only where it does.
    githubWorkflows: has('triggers.workflows' satisfies ConnectorCloudFeature),
    // Whether it sends github.ci_finished, so trigger-options and watch-pr use it only where it does.
    githubCiFinished: has('triggers.ci_finished' satisfies ConnectorCloudFeature),
    // Whether it reads a bot's channelHello, so the Slack intro switch is offered only where it does.
    // From the last answer, so the owner can still see and change it while the cloud is out of reach:
    // the next hello carries it.
    slackChannelHello: has(CONNECTOR_CLOUD_SLACK_CHANNEL_HELLO_FEATURE)
  }
}

export type ConnectorBotListFacts = ReturnType<typeof connectorCloudFeatureFacts> & {
  threadReplies: boolean
  connectorStatus: ConnectorCloudStatus
  connectorMessage?: string
  connectorNeedsSignIn?: true
}

export function connectorBotListFacts(link: {
  status: ConnectorCloudStatus
  needsSignIn: boolean
  /** The cloud's reason for refusing the connection, when it gave one. */
  refusal: string | null | undefined
  threadReplies: boolean
  features: ReadonlySet<string> | null
}): ConnectorBotListFacts {
  const { status } = link
  return {
    threadReplies: link.threadReplies,
    ...connectorCloudFeatureFacts(link.features),
    connectorStatus: status,
    ...((status === 'refused' || status === 'needs-sign-in') && link.refusal
      ? { connectorMessage: link.refusal }
      : {}),
    ...(link.needsSignIn || status === 'needs-sign-in' ? { connectorNeedsSignIn: true } : {})
  }
}
