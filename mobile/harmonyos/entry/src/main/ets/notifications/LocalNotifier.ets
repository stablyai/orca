import { getBool, KEY_NOTIFICATIONS_LOCAL_ENABLED, KEY_NOTIFICATIONS_DND_ENABLED } from '../settings/SettingsStore';
import { notificationManager } from '@kit.NotificationKit';
import notification from '@ohos.notification';
import { common, wantAgent } from '@kit.AbilityKit';
import { BusinessError } from '@kit.BasicServicesKit';

/** 本机通知发布器：发布前检查偏好，点击后通过 WantAgent 打开对应会话。 */

const EXTRA_HOST_ID = 'orca_hostId';
const EXTRA_WORKTREE_ID = 'orca_worktreeId';

export class LocalNotifier {
  private logSink: ((line: string) => void) | null = null;
  private slotReady: boolean = false;
  private context: common.UIAbilityContext | null = null;

  setLogSink(sink: (line: string) => void): void {
    this.logSink = sink;
  }

  private log(line: string): void {
    if (this.logSink) {
      this.logSink(line);
    }
  }

  /**
   * Creates the agent notification slot once. Safe to call repeatedly; the slot
   * add is retried on later calls if it failed before.
   */
  async ensureSlot(): Promise<boolean> {
    try {
      if (this.slotReady) {
        return true;
      }
      await notificationManager.addSlot(notificationManager.SlotType.SOCIAL_COMMUNICATION);
      this.slotReady = true;
      this.log('notification slot ready (SOCIAL_COMMUNICATION / high importance)');
      return true;
    } catch (e) {
      this.log(`ensureSlot 失败（可能无通知权限）: ${(e as Error).message}`);
      return false;
    }
  }

  /**
   * One-time enable prompt for the app's notifications. Failures are non-fatal:
   * publish() may still work for local notifications on some builds.
   */
  async requestEnable(context: common.UIAbilityContext): Promise<boolean> {
    this.context = context;
    try {
      await notificationManager.requestEnableNotification(context);
      this.log('notification enabled');
      return true;
    } catch (e) {
      this.log(`requestEnableNotification 失败: ${(e as Error).message}`);
      return false;
    }
  }

  /**
   * Publishes an agent event notification. Fire-and-forget: returns true when the
   * request was handed to the notification service without throwing.
   */
  publishAgentEvent(title: string, body: string, hostId: string, worktreeId: string): boolean {
    if (!this.context) { return false; }
    this.publishChecked(title, body, hostId, worktreeId).catch((): void => this.log('通知发布失败，请检查系统权限'));
    return true;
  }
  private async publishChecked(title: string, body: string, hostId: string, worktreeId: string): Promise<void> {
    let context = this.context!;
    if (!await getBool(context, KEY_NOTIFICATIONS_LOCAL_ENABLED)
      || await getBool(context, KEY_NOTIFICATIONS_DND_ENABLED)) { return; }
    let id = Date.now() % 2147483647;
    let agent = await wantAgent.getWantAgent({
      wants: [{ bundleName: 'com.jsy.orca.mobile', abilityName: 'EntryAbility',
        uri: `orca://session?hostId=${encodeURIComponent(hostId)}&worktreeId=${encodeURIComponent(worktreeId)}` }],
      operationType: wantAgent.OperationType.START_ABILITY, requestCode: id,
      wantAgentFlags: [wantAgent.WantAgentFlags.UPDATE_PRESENT_FLAG]
    });
    let request: notificationManager.NotificationRequest = {
      id: id, content: { contentType: notification.ContentType.NOTIFICATION_CONTENT_BASIC_TEXT,
        normal: { title: title, text: body } }, slotType: notification.SlotType.SOCIAL_COMMUNICATION,
      wantAgent: agent, autoDeletedTime: Date.now() + 24 * 60 * 60 * 1000
    };
    await notificationManager.publish(request);
  }
}
