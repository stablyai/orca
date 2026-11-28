/** Registers ZCode as an Orca chat provider: metadata plus the adapter the host builds. */

import { homedir } from 'node:os'
import { join } from 'node:path'
import { agentSessionAccountHome } from '../../../shared/agent-session/lifecycle/accounts/agent-session-account-home'
import type {
  StructuredAgentRuntimeMetadata,
  StructuredAgentRuntimeRegistration,
  StructuredAgentAdapterContext,
  StructuredAgentRuntimeAdapter
} from '../../runtime/agent-session/installation/structured-agent-runtime-registration-types'
import {
  composeStructuredLaunch,
  structuredAgentLaunchSources
} from '../../runtime/agent-session/launch/structured-agent-launch-composition'
import { supportsSupervisedProviderChildLocation } from '../../provider-process/supervised-provider-child-location'
import {
  resumeInvocationFromOptions,
  type StructuredAgentSessionHistory
} from '../../native-chat/conversation-adoption/structured-agent-cli-conversations'
import { ZCODE_STRUCTURED_AGENT } from './zcode-agent-definition'
import { resolveZcodeCommand } from './zcode-command'
import { zcodeLaunchPart } from './zcode-launch'
import { ZcodeStructuredSessionAdapter } from './zcode-session-adapter'

const ZCODE_SESSION_HISTORY: StructuredAgentSessionHistory = {
  rowAgents: ['zcode'],
  rowSessionId: (link) => link.handle.nativeId,
  parseResumeArgs: (args) =>
    resumeInvocationFromOptions(args, { targetless: ['-c', '--continue'], markers: ['--resume'] })
}

export const ZCODE_RUNTIME_METADATA: StructuredAgentRuntimeMetadata = {
  definition: ZCODE_STRUCTURED_AGENT,
  // ZCode's model listing needs its own probe; chats still run on the model its CLI resolves.
  modelCatalog: () => ({
    kind: 'unavailable',
    reason: 'ZCode chat model listing is not implemented; the CLI resolves its own default.'
  }),
  supportsLocation: supportsSupervisedProviderChildLocation,
  transcriptImport: null,
  sessionHistory: ZCODE_SESSION_HISTORY,
  chatProgram: {
    resolve: (env, commandSettings) => {
      const command = resolveZcodeCommand(env, commandSettings)
      return { command: command.command, prefixArgs: command.prefixArgs ?? [], env }
    }
  },
  launchCheck: {
    resolveLaunch: (env, commandSettings) => {
      const command = resolveZcodeCommand(env, commandSettings)
      return { command: command.command, prefixArgs: command.prefixArgs ?? [], env }
    },
    minimumVersions: []
  },
  resolveAccountHome: async ({ launchEnv }) =>
    agentSessionAccountHome(
      ZCODE_STRUCTURED_AGENT,
      launchEnv.ZCODE_CLI_SETTINGS_FILE?.trim() || join(homedir(), '.zcode', 'cli', 'setting.json')
    )
}

function createZcodeAdapter(context: StructuredAgentAdapterContext): StructuredAgentRuntimeAdapter {
  const { deps } = context
  return new ZcodeStructuredSessionAdapter({
    resolveLaunch: composeStructuredLaunch(
      ZCODE_STRUCTURED_AGENT,
      structuredAgentLaunchSources(context),
      zcodeLaunchPart()
    ),
    persistResumePoint: async ({ sessionId, fence, link }) => {
      // A first conversation has no chain head to revise; its resume point opens the chain.
      const fresh = (context.store.getRecord(sessionId)?.providerHandleChain.length ?? 0) === 0
      await context.store.updateRecord(
        sessionId,
        fresh
          ? { kind: 'provider-handle', args: { fence, link, now: Date.now() }, launched: null }
          : { kind: 'resume-point', args: { fence, handle: link.handle, now: Date.now() } }
      )
    },
    onSettled: ({ sessionId, clientMessageId, outcome }) => {
      if (outcome.state !== 'admitted') {
        context.followUps.onDispatchSettledLate({ sessionId, clientMessageId, ...outcome })
      }
    },
    ...(deps.readProcessStartTime ? { readProcessStartTime: deps.readProcessStartTime } : {}),
    logger: deps.logger
  })
}

export const ZCODE_RUNTIME_REGISTRATION: StructuredAgentRuntimeRegistration = Object.assign(
  ZCODE_RUNTIME_METADATA,
  { createAdapter: createZcodeAdapter }
)
