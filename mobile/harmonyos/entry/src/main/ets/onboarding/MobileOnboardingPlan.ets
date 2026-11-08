import { common } from '@kit.AbilityKit';
import { preferences } from '@kit.ArkData';
import { KEY_DEFAULT_SESSION_VIEW, KEY_NOTIFICATIONS_LOCAL_ENABLED, setString, setBool } from '../settings/SettingsStore';

export function loadMobileOnboardingSteps(context: common.Context): string[] {
  let prefs = preferences.getPreferencesSync(context, { name: 'orca_settings' });
  let steps: string[] = [];
  let view = prefs.getSync(KEY_DEFAULT_SESSION_VIEW, '');
  if (view !== 'chat' && view !== 'terminal') { steps.push('session-view'); }
  let notifications = prefs.getSync(KEY_NOTIFICATIONS_LOCAL_ENABLED, '');
  if (typeof notifications !== 'boolean') { steps.push('online-notifications'); }
  return steps;
}

export async function saveOnboardingSessionView(context: common.Context, value: string): Promise<void> {
  if (value !== 'chat' && value !== 'terminal') { throw new Error('Invalid session view'); }
  await setString(context, KEY_DEFAULT_SESSION_VIEW, value);
}

export async function saveOnboardingOnlineNotifications(context: common.Context, enabled: boolean): Promise<void> {
  await setBool(context, KEY_NOTIFICATIONS_LOCAL_ENABLED, enabled);
}
