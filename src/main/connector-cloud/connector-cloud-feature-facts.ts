// What bots.list says the host's Orca Cloud takes, from its last hello answer; all false before one.
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
    slackChannelHello: has(CONNECTOR_CLOUD_SLACK_CHANNEL_HELLO_FEATURE)
  }
}
