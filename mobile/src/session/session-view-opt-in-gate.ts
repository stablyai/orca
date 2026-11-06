import { readDefaultSessionViewPreference } from '../storage/session-view-preferences'

// Prompt only after a successful read proves no saved preference; transient storage failure must not block startup.
export async function shouldPresentSessionViewOptIn(): Promise<boolean> {
  const preference = await readDefaultSessionViewPreference()
  return preference.loaded && !preference.hasStoredValue
}
