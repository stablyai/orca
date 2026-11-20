import {
  type AppCaller,
  registerAppHandler,
  isRegisteredMainAppCaller
} from '../app-registry/app-handler-registry'

import type { AppChannel } from '../../../shared/app-ipc/app-channel-manifest'

export function handleMainWindowSkillIpc<Args extends unknown[], Result>(
  channel: AppChannel,
  listener: (event: AppCaller, ...args: Args) => Result
): void {
  registerAppHandler(channel, (event, ...args) => {
    if (!isRegisteredMainAppCaller(event)) {
      throw new Error('Unauthorized skill IPC sender')
    }
    return listener(event, ...(args as Args))
  })
}
