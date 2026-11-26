// What `bots.list` says of this host's connector: the cloud's features the bot UI offers, and its status.
import type { ConnectorCloudStatus } from '../../shared/bots/connector-cloud-status'
import type { ConnectorCloudFeature } from '../../shared/connectors/connector-cloud-contract'
import type { ConnectorCloud } from './connector-cloud'

export type ConnectorBotListFacts = {
  threadReplies: boolean
  githubEvents2: boolean
  githubWorkflows: boolean
  githubCiFinished: boolean
  connectorStatus: ConnectorCloudStatus
  connectorMessage?: string
  connectorNeedsSignIn?: true
}

/** `refusal`: the cloud's words for the owner on its last refusal, if any. */
export function connectorBotListFacts(
  cloud: Pick<ConnectorCloud, 'status' | 'cloudFeatures' | 'needsSignIn' | 'takesThreadReplies'>,
  refusal: string | null
): ConnectorBotListFacts {
  const connectorStatus = cloud.status()
  const features = cloud.cloudFeatures()
  const needsSignIn = cloud.needsSignIn() || connectorStatus === 'needs-sign-in'
  return {
    threadReplies: cloud.takesThreadReplies(),
    // Whether it sends GitHub's newer events and label=, so trigger-options offers only those it does.
    githubEvents2: features?.has('triggers.github2' satisfies ConnectorCloudFeature) === true,
    // Whether it sends github.workflow_finished, so trigger-options offers it only where it does.
    githubWorkflows: features?.has('triggers.workflows' satisfies ConnectorCloudFeature) === true,
    // Whether it sends github.ci_finished, so trigger-options and watch-pr use it only where it does.
    githubCiFinished:
      features?.has('triggers.ci_finished' satisfies ConnectorCloudFeature) === true,
    connectorStatus,
    ...((connectorStatus === 'refused' || connectorStatus === 'needs-sign-in') && refusal
      ? { connectorMessage: refusal }
      : {}),
    ...(needsSignIn ? { connectorNeedsSignIn: true } : {})
  }
}
