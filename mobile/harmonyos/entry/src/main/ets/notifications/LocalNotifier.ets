import { getBool, KEY_NOTIFICATIONS_LOCAL_ENABLED, KEY_NOTIFICATIONS_DND_ENABLED, notificationDeliveryPreferences } from '../settings/SettingsStore';
import { notificationManager } from '@kit.NotificationKit';
import notification from '@ohos.notification';
import { common, wantAgent } from '@kit.AbilityKit';


/** 本机通知发布器：发布前检查偏好，点击后通过 WantAgent 打开对应会话。 */

export interface DesktopNotification {
  title: string; body: string; hostId: string; worktreeId: string; paneKey: string; executionHost: string;
  source: string; agentState: string; desktopAway: boolean | null; notificationId: string;
}

let nextNotificationId = 0;

export class LocalNotifier {
  private logSink: ((line: string) => void) | null = null;
  private slotReady: boolean = false;
  private context: common.UIAbilityContext | null = null;
  private viewingHost = '';
  private viewingWorktree = '';
  private viewingExecutionHost = '';
  private delivered: Map<string, number> = new Map();
  private dismissed: Set<string> = new Set();

  setViewing(hostId: string, worktreeId: string, executionHost: string = ''): void {
    this.viewingHost = hostId; this.viewingWorktree = worktreeId; this.viewingExecutionHost = executionHost;
  }

  publishDesktopEvent(event: DesktopNotification): boolean {
    if (!this.context) { return false; }
    this.publishDesktopEventAsync(event)
      .catch((): void => this.log('通知发布失败，请检查系统权限'));
    return true;
  }

  async publishDesktopEventAsync(event: DesktopNotification): Promise<boolean> {
    if (!this.context) { return false; }
    return this.publishChecked(event.title, event.body, event.hostId, event.worktreeId, event.paneKey, event.executionHost, event);
  }

  async dismiss(notificationId: string): Promise<void> {
    this.dismissed.add(notificationId);
    if (this.dismissed.size > 128) { this.dismissed.delete(Array.from(this.dismissed)[0]); }
    let id = this.delivered.get(notificationId);
    if (id !== undefined) { await notificationManager.cancel(id); this.delivered.delete(notificationId); }
  }

  async displayTest(context: common.UIAbilityContext): Promise<boolean> {
    this.context = context;
    return this.publishChecked('Orca 通知测试', '这是一条本机展示测试通知。', '', '', '', '', null, true);
  }

  setContext(context: common.UIAbilityContext): void { this.context = context; }

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
      let enabled = await notificationManager.isNotificationEnabled();
      this.log(enabled ? 'notification enabled' : 'notification permission not enabled');
      return enabled;
    } catch (e) {
      this.log(`requestEnableNotification 失败: ${(e as Error).message}`);
      return false;
    }
  }

  /**
   * Queues delivery; the async path applies preferences and current OS permission.
   */
  publishAgentEvent(title: string, body: string, hostId: string, worktreeId: string, paneKey: string = '', executionHost: string = ''): boolean {
    if (!this.context) { return false; }
    try { if (!notificationManager.isNotificationEnabledSync()) { return false; } } catch (e) { return false; }
    this.publishChecked(title, body, hostId, worktreeId, paneKey, executionHost).catch((): void => this.log('通知发布失败，请检查系统权限'));
    return true;
  }
  private async publishChecked(title: string, body: string, hostId: string, worktreeId: string, paneKey: string, executionHost: string, event: DesktopNotification | null = null, test: boolean = false): Promise<boolean> {
    let context = this.context!;
    if (!test && (!await getBool(context, KEY_NOTIFICATIONS_LOCAL_ENABLED)
      || await getBool(context, KEY_NOTIFICATIONS_DND_ENABLED))) { return false; }
    let preferences = notificationDeliveryPreferences(context);
    if (!test && preferences.suppressWhileViewing && hostId === this.viewingHost && worktreeId === this.viewingWorktree
      && executionHost === this.viewingExecutionHost) { return false; }
    if (event && ((preferences.onlyWhenDesktopAway && event.desktopAway === false)
      || (preferences.onlyWhenAgentNeedsInput && event.source === 'agent-task-complete' &&
        !['blocked', 'waiting', 'needs-input'].includes(event.agentState)))) { return false; }
    if (!await notificationManager.isNotificationEnabled() || !await this.ensureSlot()) { return false; }
    nextNotificationId = Math.max(nextNotificationId + 1, Date.now() % 2000000000); let id = nextNotificationId;
    let uri = `orca://session?hostId=${encodeURIComponent(hostId)}`;
    if (worktreeId.length > 0) { uri += `&worktreeId=${encodeURIComponent(worktreeId)}`; }
    if (paneKey.length > 0) { uri += `&paneKey=${encodeURIComponent(paneKey)}`; }
    if (/^runtime:.+/.test(executionHost)) { uri += `&executionHost=${encodeURIComponent(executionHost)}`; }
    let want: ESObject = { bundleName: 'com.jsy.orca.mobile', abilityName: 'EntryAbility' };
    if (hostId.length > 0) { want.uri = uri; }
    let agent = await wantAgent.getWantAgent({
      wants: [want],
      operationType: wantAgent.OperationType.START_ABILITY, requestCode: id,
      wantAgentFlags: [wantAgent.WantAgentFlags.UPDATE_PRESENT_FLAG]
    });
    let request: notificationManager.NotificationRequest = {
      id: id, content: { contentType: notification.ContentType.NOTIFICATION_CONTENT_BASIC_TEXT,
        normal: { title: title, text: body } }, slotType: notification.SlotType.SOCIAL_COMMUNICATION,
      wantAgent: agent, autoDeletedTime: Date.now() + 24 * 60 * 60 * 1000
    };
    if (!preferences.sound) { request.notificationFlags = { soundEnabled: 2 }; }
    if (event && this.dismissed.has(event.notificationId)) { return false; }
    await notificationManager.publish(request);
    if (event && this.dismissed.has(event.notificationId)) { await notificationManager.cancel(id); return false; }
    if (event && event.notificationId.length > 0) {
      this.delivered.set(event.notificationId, id);
      if (this.delivered.size > 128) { this.delivered.delete(Array.from(this.delivered.keys())[0]); }
    }
    return true;
  }
}
