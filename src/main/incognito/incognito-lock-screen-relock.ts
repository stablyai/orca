import { powerMonitor } from 'electron'
import type { IncognitoProjectsLock } from './incognito-projects-lock'

type RelockEvent = 'lock-screen' | 'suspend'

type RelockEventSource = {
  on(event: RelockEvent, listener: () => void): unknown
}

/** Walking away from the machine ends the unlock; Linux only reports suspend. */
export function registerIncognitoLockScreenRelock(
  lock: Pick<IncognitoProjectsLock, 'lock'>,
  source: RelockEventSource = powerMonitor
): void {
  const relock = (): void => {
    void lock.lock()
  }
  source.on('lock-screen', relock)
  source.on('suspend', relock)
}
