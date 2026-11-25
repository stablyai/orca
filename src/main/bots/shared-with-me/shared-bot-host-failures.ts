// What a teammate's computer reports when a share's accept, link or list fails: each once per failing
// streak, never per poll, and a host that is simply away is not a failure.
import type { SharedHostLink } from '../../../shared/remote-runtime/relay/client/shared-host-relay-link'
import type { ConnectorResult } from '../../connector-cloud/connector-cloud-request'
import type { SharedBotsCloud } from './shared-bots-cloud'
import {
  AgentShareFailureStreaks,
  agentShareCloudReason,
  reportAgentShareFailure
} from '../../telemetry/agent-share-failure'

// Reads of the shares list that may go unanswered before it is reported.
const UNANSWERED_READS_REPORTED = 4

export class SharedBotHostFailures {
  private readonly streaks = new AgentShareFailureStreaks()
  private unansweredReads = 0

  accepted(shareId: string, answer: ConnectorResult<unknown>): void {
    if (answer.ok) {
      this.streaks.clear(`accept:${shareId}`)
    } else {
      this.streaks.report(`accept:${shareId}`, {
        stage: 'accept',
        reason: agentShareCloudReason(answer)
      })
    }
  }

  /** Only a host Orca Cloud says is online but this link can't reach counts. */
  linked(shareId: string, link: SharedHostLink, hostOnline: boolean): void {
    if (link === 'live' || !hostOnline) {
      this.streaks.clear(`link:${shareId}`)
    } else {
      this.streaks.report(`link:${shareId}`, {
        stage: 'host_unreachable',
        reason: link === 'unpaired' ? 'pairing_refused' : 'not_reached'
      })
    }
  }

  /** No answer or a 5xx several reads running; any other answer ends the streak. */
  listed(answer: ConnectorResult<unknown> | null): void {
    const unanswered = answer !== null && !answer.ok && (answer.status ?? 500) >= 500
    this.unansweredReads = unanswered ? this.unansweredReads + 1 : 0
    if (this.unansweredReads === UNANSWERED_READS_REPORTED && answer && !answer.ok) {
      reportAgentShareFailure({
        stage: 'host_status_unknown',
        reason: answer.status === null ? 'network' : 'http_5xx'
      })
    }
  }
}

/** `cloud`, reporting its accept and shares-list failures to `failures`. */
export function reportingSharedBotsCloud(
  cloud: SharedBotsCloud,
  failures: SharedBotHostFailures
): SharedBotsCloud {
  return {
    ...cloud,
    mine: async () => {
      const answer = await cloud.mine()
      failures.listed(answer)
      return answer
    },
    accept: async (shareId, request) => {
      const answer = await cloud.accept(shareId, request)
      failures.accepted(shareId, answer)
      return answer
    }
  }
}
