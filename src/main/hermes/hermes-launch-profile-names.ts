import {
  HERMES_PROFILE_NAME,
  readHermesProfileName
} from '../../shared/agent-launch/startup/hermes-profile'

/** Directory names under `profiles/` that launch a named profile; `default` is the root home. */
export function hermesProfileNames(names: readonly string[]): string[] {
  return names
    .filter((name) => name !== 'default' && HERMES_PROFILE_NAME.test(name))
    .sort()
}

/** The sticky `hermes profile use` choice, or null when the root home is active. */
export function hermesActiveProfileName(content: string | null): string | null {
  return content === null ? null : (readHermesProfileName(content) ?? null)
}
