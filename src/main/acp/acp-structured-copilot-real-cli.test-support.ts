// Shared opt-in gate and streamed-text reader for the Copilot real-CLI suites.

import { isAbsolute } from 'node:path'
import { definedEnv } from '../runtime/structured-agent-launch-composition.test-support'
import { acpLaunchSpecFor } from './acp-launch-specs'
import type { AcpSessionEvent } from './acp-session-runtime'
import { resolveAcpLaunchCommand } from './acp-structured-launch-resolution'

export const COPILOT = acpLaunchSpecFor('copilot')!

export function copilotCliPresent(): boolean {
  return isAbsolute(
    resolveAcpLaunchCommand(COPILOT, definedEnv(process.env), { dataDirectory: null })
  )
}

export function streamedReply(events: readonly AcpSessionEvent[], sessionId: string): string {
  return events
    .flatMap((event) => {
      if (event.kind !== 'known' || event.notification.sessionId !== sessionId) {
        return []
      }
      const update = event.notification.update
      return update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text'
        ? [update.content.text]
        : []
    })
    .join('')
}
