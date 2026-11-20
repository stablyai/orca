import { type AppCaller, registerAppHandler } from '../app-registry/app-handler-registry'

import type { AppChannel } from '../../../shared/app-ipc/app-channel-manifest'

export function handleMainWindowSkillIpc<Args extends unknown[], Result>(
  channel: AppChannel,
  listener: (event: AppCaller, ...args: Args) => Result
): void {
  registerAppHandler(channel, (event, ...args) => {
    if (event.role !== 'main') {
      throw new Error('Unauthorized skill IPC sender')
    }
    return listener(event, ...(args as Args))
  })
}
