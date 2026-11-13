import { notificationDeliveryEnabled, notificationDeliveryPreferences, NotificationDeliveryPreferences } from '../settings/SettingsStore';
import { notificationManager } from '@kit.NotificationKit';
import notification from '@ohos.notification';
import { common, wantAgent } from '@kit.AbilityKit';
import { notificationFenceKey, NotificationIdentity, readNotificationIdentity } from './NotificationIdentity';


/** 本机通知发布器：发布前检查偏好，点击后通过 WantAgent 打开对应会话。 */

export interface DesktopNotification {
  title: string; body: string; hostId: string; worktreeId: string; paneKey: string; executionHost: string;
  source: string; agentState: string; desktopAway: boolean | null; identity: NotificationIdentity | null;
  emittedAt?: number; attentionKey?: string;
}

interface TrayDelivery { id: number; identity: NotificationIdentity; }
const NOTIFICATION_COOLDOWN_MS = 5000;
const NOTIFICATION_FLAG_CLOSE = 2;

let nextNotificationId = 0;

export class LocalNotifier {
  private logSink: ((line: string) => void) | null = null;
  private slotReady: boolean = false;
  private context: common.UIAbilityContext | null = null;
  private viewingHost = '';
  private viewingWorktree = '';
  private viewingExecutionHost = '';
  private dismissed: Map<string, number> = new Map();
  private recent: Map<string, number> = new Map();

  setViewing(hostId: string, worktreeId: string, executionHost: string = ''): void {
    this.viewingHost = hostId; this.viewingWorktree = worktreeId; this.viewingExecutionHost = executionHost;
  }

  publishDesktopEvent(event: DesktopNotification, current: () => boolean): boolean {
    if (!this.context) { return false; }
    this.publishDesktopEventAsync(event, current)
      .catch((): void => this.log('通知发布失败，请检查系统权限'));
    return true;
  }

  async publishDesktopEventAsync(event: DesktopNotification, current: () => boolean = (): boolean => true): Promise<boolean> {
    if (!this.context) { return false; }
    return this.publishChecked(event.title, event.body, event.hostId, event.worktreeId, event.paneKey, event.executionHost, event, false, current);
  }

  private rememberDismissal(identity: NotificationIdentity): void {
    let key = notificationFenceKey(identity);
    let previous = this.dismissed.get(key) ?? -1;
    this.dismissed.delete(key);
    this.dismissed.set(key, Math.max(previous, identity.notificationSeq));
    if (this.dismissed.size > 256) { this.dismissed.delete(Array.from(this.dismissed.keys())[0]); }
  }

  private isDismissed(identity: NotificationIdentity): boolean {
    return (this.dismissed.get(notificationFenceKey(identity)) ?? -1) >= identity.notificationSeq;
  }

  private async tray(hostId: string): Promise<TrayDelivery[]> {
    let deliveries: TrayDelivery[] = [];
    for (let request of await notificationManager.getActiveNotifications()) {
      let info = request.extraInfo;
      if (info?.['orcaDesktopId'] !== hostId || typeof request.id !== 'number') { continue; }
      let identity = readNotificationIdentity(info);
      if (identity) { deliveries.push({ id: request.id, identity: identity }); }
      if (deliveries.length === 2048) { break; }
    }
    return deliveries;
  }

  async dismiss(hostId: string, identity: NotificationIdentity): Promise<void> {
    this.rememberDismissal(identity);
    for (let delivery of await this.tray(hostId)) {
      if (this.isDismissed(delivery.identity)) { await notificationManager.cancel(delivery.id).catch(() => {}); }
    }
  }

  async reconcile(hostId: string, readDismissals: (delivered: NotificationIdentity[]) => Promise<NotificationIdentity[]>,
    current: () => boolean): Promise<void> {
    let deliveries = await this.tray(hostId);
    for (let offset = 0; offset < deliveries.length && current(); offset += 256) {
      let page = deliveries.slice(offset, offset + 256);
      let confirmed = await readDismissals(page.map((delivery: TrayDelivery): NotificationIdentity => delivery.identity));
      if (!current()) { return; }
      for (let delivery of page) {
        let target = delivery.identity;
        if (confirmed.some((candidate: NotificationIdentity): boolean => candidate.notificationId === target.notificationId
          && candidate.notificationEpoch === target.notificationEpoch && candidate.notificationSeq === target.notificationSeq)) {
          this.rememberDismissal(target);
          await notificationManager.cancel(delivery.id).catch(() => {});
        }
      }
    }
  }

  private reserveAlert(event: DesktopNotification): boolean {
    let at = event.emittedAt;
    if (at === undefined) { return true; }
    let key = event.attentionKey || event.worktreeId || 'global';
    let previous = this.recent.get(key);
    if (previous !== undefined && at - previous < NOTIFICATION_COOLDOWN_MS) { return false; }
    this.recent.delete(key);
    this.recent.set(key, at);
    if (this.recent.size > 50) { this.recent.delete(Array.from(this.recent.keys())[0]); }
    return true;
  }

  async displayTest(context: common.UIAbilityContext, title: string, body: string): Promise<boolean> {
    this.context = context;
    return this.publishChecked(title, body, '', '', '', '', null, true);
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
   * Queues delivery; the async path applies preferences and current OS permission.
   */
  publishAgentEvent(title: string, body: string, hostId: string, worktreeId: string, paneKey: string = '', executionHost: string = ''): boolean {
    if (!this.context) { return false; }
    try { if (!notificationManager.isNotificationEnabledSync()) { return false; } } catch (e) { return false; }
    this.publishChecked(title, body, hostId, worktreeId, paneKey, executionHost).catch((): void => this.log('通知发布失败，请检查系统权限'));
    return true;
  }
  private deliveryPreferences(hostId: string, worktreeId: string, executionHost: string,
    event: DesktopNotification | null, test: boolean): NotificationDeliveryPreferences | null {
    let context = this.context!;
    if (!test && !notificationDeliveryEnabled(context)) { return null; }
    let preferences = notificationDeliveryPreferences(context);
    if (!test && preferences.suppressWhileViewing && hostId === this.viewingHost && worktreeId === this.viewingWorktree
      && executionHost === this.viewingExecutionHost) { return null; }
    if (event && ((preferences.onlyWhenDesktopAway && event.desktopAway === false)
      || (preferences.onlyWhenAgentNeedsInput && event.source === 'agent-task-complete' &&
        !['blocked', 'waiting', 'needs-input'].includes(event.agentState)))) { return null; }
    return preferences;
  }
  private async publishChecked(title: string, body: string, hostId: string, worktreeId: string, paneKey: string,
    executionHost: string, event: DesktopNotification | null = null, test: boolean = false,
    current: () => boolean = (): boolean => true): Promise<boolean> {
    let context = this.context!;
    let preferences = this.deliveryPreferences(hostId, worktreeId, executionHost, event, test);
    if (!preferences) { return false; }
    if (!await notificationManager.isNotificationEnabled() || !await this.ensureSlot()) { return false; }
    nextNotificationId = Math.max(nextNotificationId + 1, Date.now() % 2000000000); let id = nextNotificationId;
    let uri = `orca://session?hostId=${encodeURIComponent(hostId)}`;
    if (worktreeId.length > 0) { uri += `&worktreeId=${encodeURIComponent(worktreeId)}`; }
    if (paneKey.length > 0) { uri += `&paneKey=${encodeURIComponent(paneKey)}`; }
    if (/^runtime:.+/.test(executionHost)) { uri += `&executionHost=${encodeURIComponent(executionHost)}`; }
    let want: ESObject = { bundleName: context.abilityInfo.bundleName, abilityName: context.abilityInfo.name };
    if (hostId.length > 0) { want.uri = uri; }
    let agent = await wantAgent.getWantAgent({
      wants: [want],
      operationType: wantAgent.OperationType.START_ABILITY, requestCode: id,
      wantAgentFlags: [wantAgent.WantAgentFlags.UPDATE_PRESENT_FLAG]
    });
    let request: notificationManager.NotificationRequest = {
      id: id, content: { contentType: notification.ContentType.NOTIFICATION_CONTENT_BASIC_TEXT,
        normal: { title: title, text: body } }, notificationSlotType: notificationManager.SlotType.SOCIAL_COMMUNICATION,
      wantAgent: agent, autoDeletedTime: Date.now() + 24 * 60 * 60 * 1000
    };
    let identity = event?.identity;
    if (identity) {
      request.extraInfo = { orcaDesktopId: hostId, notificationId: identity.notificationId,
        notificationEpoch: identity.notificationEpoch, notificationSeq: identity.notificationSeq };
      request.appMessageId = `${hostId}/${identity.notificationEpoch}/${identity.notificationSeq}`;
    }
    preferences = this.deliveryPreferences(hostId, worktreeId, executionHost, event, test);
    if (!preferences || !current() || (identity && this.isDismissed(identity)) || (event && !this.reserveAlert(event))) { return false; }
    if (!preferences.sound) { request.notificationFlags = { soundEnabled: NOTIFICATION_FLAG_CLOSE, vibrationEnabled: NOTIFICATION_FLAG_CLOSE }; }
    await notificationManager.publish(request);
    if (!current() || (identity && this.isDismissed(identity))) { await notificationManager.cancel(id); return false; }
    return true;
  }
}
