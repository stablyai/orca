import { common } from '@kit.AbilityKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { notificationManager } from '@kit.NotificationKit';
import { getBool, KEY_NOTIFICATIONS_PERMISSION_DECIDED, setBool } from '../settings/SettingsStore';

export type NotificationPermissionState = 'undetermined' | 'denied' | 'granted';
const NOTIFICATION_PERMISSION_REFUSED = 1600004;

export async function readNotificationPermission(context: common.UIAbilityContext): Promise<NotificationPermissionState> {
  let granted = await notificationManager.isNotificationEnabled();
  let decided = await getBool(context, KEY_NOTIFICATIONS_PERMISSION_DECIDED);
  if (granted) {
    if (!decided) { await setBool(context, KEY_NOTIFICATIONS_PERMISSION_DECIDED, true); }
    return 'granted';
  }
  return decided ? 'denied' : 'undetermined';
}

export async function requestNotificationPermission(context: common.UIAbilityContext): Promise<NotificationPermissionState> {
  let state = await readNotificationPermission(context);
  if (state !== 'undetermined') { return state; }
  try { await notificationManager.requestEnableNotification(context); }
  catch (error) { if ((error as BusinessError).code !== NOTIFICATION_PERMISSION_REFUSED) { throw new Error((error as Error).message); } }
  await setBool(context, KEY_NOTIFICATIONS_PERMISSION_DECIDED, true);
  return readNotificationPermission(context);
}

export async function openNotificationPermissionSettings(context: common.UIAbilityContext): Promise<NotificationPermissionState> {
  await notificationManager.openNotificationSettingsWithResult(context);
  return readNotificationPermission(context);
}
