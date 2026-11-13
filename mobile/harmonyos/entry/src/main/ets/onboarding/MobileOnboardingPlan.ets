import { common } from '@kit.AbilityKit';
import { preferences } from '@kit.ArkData';
import { KEY_DEFAULT_SESSION_VIEW, KEY_NOTIFICATIONS_LOCAL_ENABLED, setString, setBool } from '../settings/SettingsStore';

const SESSION_VIEW = 'session-view';
const ONLINE_NOTIFICATIONS = 'online-notifications';

function choiceIsMissing(prefs: preferences.Preferences, key: string): boolean {
  try { return !prefs.hasSync(key); }
  catch (e) { return false; }
}

export function loadMobileOnboardingSteps(context: common.Context): string[] {
  let steps: string[] = [];
  try {
    let prefs = preferences.getPreferencesSync(context, { name: 'orca_settings' });
    if (choiceIsMissing(prefs, KEY_DEFAULT_SESSION_VIEW)) { steps.push(SESSION_VIEW); }
    if (choiceIsMissing(prefs, KEY_NOTIFICATIONS_LOCAL_ENABLED)) { steps.push(ONLINE_NOTIFICATIONS); }
  } catch (e) {}
  return steps;
}

export function parseMobileOnboardingSteps(raw: string): string[] {
  let requested = raw.split(',');
  return [SESSION_VIEW, ONLINE_NOTIFICATIONS].filter((step: string): boolean => requested.includes(step));
}

export async function saveOnboardingSessionView(context: common.Context, value: string): Promise<void> {
  if (value !== 'chat' && value !== 'terminal') { throw new Error('Invalid session view'); }
  await setString(context, KEY_DEFAULT_SESSION_VIEW, value);
}

export async function saveOnboardingOnlineNotifications(context: common.Context, enabled: boolean): Promise<void> {
  await setBool(context, KEY_NOTIFICATIONS_LOCAL_ENABLED, enabled);
}
