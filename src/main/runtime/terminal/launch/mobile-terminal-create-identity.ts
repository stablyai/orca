import type { MobileTerminalCreateOptions } from './mobile-terminal-create'
import { deterministicAgentSessionUuid } from './runtime-agent-launch-resolution'

export function freshMobileTerminalCreateIdentity(
  worktreeId: string,
  opts: Pick<MobileTerminalCreateOptions, 'clientMutationId' | 'clientNavigationId'>
) {
  return opts.clientMutationId
    ? {
        createMutation: {
          clientIdentity: opts.clientNavigationId ?? 'local',
          id: opts.clientMutationId
        },
        identity: {
          tabId: deterministicAgentSessionUuid(
            `mobile-terminal-tab\0${opts.clientNavigationId ?? 'local'}\0${worktreeId}\0${opts.clientMutationId}`
          ),
          leafId: deterministicAgentSessionUuid(
            `mobile-terminal-leaf\0${opts.clientNavigationId ?? 'local'}\0${worktreeId}\0${opts.clientMutationId}`
          )
        }
      }
    : {}
}
