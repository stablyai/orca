import type {
  Automation,
  AutomationOnNoReusableSession
} from '../../shared/automations/automation-definition'
import { RuntimeClientError } from '../runtime-client'

export type AutomationSessionReuseFlags = {
  reuseSession?: boolean
  onNoReusableSession?: AutomationOnNoReusableSession
}

export function getReuseSessionFlag(flags: Map<string, string | boolean>): boolean | undefined {
  const reuseFlag = flags.get('reuse-session')
  const freshFlag = flags.get('fresh-session')
  if (typeof reuseFlag === 'string') {
    throw new RuntimeClientError('invalid_argument', '--reuse-session does not take a value')
  }
  if (typeof freshFlag === 'string') {
    throw new RuntimeClientError('invalid_argument', '--fresh-session does not take a value')
  }
  const reuse = reuseFlag === true
  const fresh = freshFlag === true
  if (reuse && fresh) {
    throw new RuntimeClientError(
      'invalid_argument',
      'Use either --reuse-session or --fresh-session, not both.'
    )
  }
  if (reuse) {
    return true
  }
  if (fresh) {
    return false
  }
  return undefined
}

export function getOnNoReusableSessionFlag(
  flags: Map<string, string | boolean>
): AutomationOnNoReusableSession | undefined {
  if (!flags.has('on-no-reusable-session')) {
    return undefined
  }
  const value = flags.get('on-no-reusable-session')
  if (value === 'skip') {
    return value
  }
  throw new RuntimeClientError(
    'invalid_argument',
    '--on-no-reusable-session must be skip: record the run as skipped instead of starting a second session.'
  )
}

/** Parse-only; each handler asserts the reuse pairing once it knows the saved automation. */
export function automationSessionReuseFlags(
  flags: Map<string, string | boolean>
): AutomationSessionReuseFlags {
  const reuseSession = getReuseSessionFlag(flags)
  const onNoReusableSession = getOnNoReusableSessionFlag(flags)
  return { reuseSession, onNoReusableSession }
}

/** The choice only describes a run that reuses a session; on edit the saved reuse still counts. */
export function assertOnNoReusableSessionReuse(
  choice: AutomationSessionReuseFlags,
  current?: Pick<Automation, 'reuseSession'>
): void {
  if (
    choice.onNoReusableSession !== undefined &&
    (choice.reuseSession ?? current?.reuseSession) !== true
  ) {
    throw new RuntimeClientError(
      'invalid_argument',
      '--on-no-reusable-session needs --reuse-session, or an automation that already reuses its session.'
    )
  }
}
