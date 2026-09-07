import { readDefaultSessionViewPreference } from '../storage/session-view-preferences'

/** Whether to show the one-time screen that lets the user pick terminal vs native
 *  chat. Present it only when the read succeeded and no default was ever saved, so
 *  people who already chose (in the opt-in or Settings) are never prompted again,
 *  and a transient storage failure doesn't trap startup behind the screen. */
export async function shouldPresentSessionViewOptIn(): Promise<boolean> {
  const preference = await readDefaultSessionViewPreference()
  return preference.loaded && !preference.hasStoredValue
}
