import { common } from '@kit.AbilityKit';
import { RpcSuccess, SpikeRpcClient } from '../transport/SpikeRpcClient';
import { AgentWatch } from './AgentWatch';
import { DesktopNotification, LocalNotifier } from './LocalNotifier';
import { NotificationIdentity, readNotificationIdentity } from './NotificationIdentity';

async function readDismissals(client: SpikeRpcClient, delivered: NotificationIdentity[]): Promise<NotificationIdentity[]> {
  // Reconcile notifications still in the tray without replaying alerts.
  let reply = await client.request('notifications.getMissedSince', JSON.stringify({
    lastSeenSeq: Number.MAX_SAFE_INTEGER, deliveredPushes: delivered
  }));
  if (!(reply instanceof RpcSuccess)) { return []; }
  let result = JSON.parse(reply.result) as Record<string, Object> | null;
  let rows = result?.['dismissedPushes'];
  if (!Array.isArray(rows)) { return []; }
  let confirmed: NotificationIdentity[] = [];
  let deliveries = rows as Array<Object>;
  for (let i = 0; i < Math.min(deliveries.length, 256); i++) {
    let identity = readNotificationIdentity(deliveries[i]);
    if (identity) { confirmed.push(identity); }
  }
  return confirmed;
}

export class DesktopNotifications {
  private notifier: LocalNotifier = new LocalNotifier();
  private watch: AgentWatch | null = null;
  private viewingOwner: Object | null = null;

  constructor(context: common.UIAbilityContext) { this.notifier.setContext(context); }

  attach(client: SpikeRpcClient, hostId: string): void {
    this.stop();
    let notifier = this.notifier;
    let watch = new AgentWatch({
      deviceToken: client.deviceToken, hostId: hostId,
      subscribe: (id: string, wire: string, onEvent: (frame: string) => void): boolean =>
        client.subscribeWithId(id, wire, onEvent),
      cancel: (id: string): void => client.cancelById(id),
      notify: (title: string, body: string, host: string, worktree: string, pane?: string, runtime?: string): boolean =>
        notifier.publishAgentEvent(title, body, host, worktree, pane, runtime),
      notifyEvent: (event: DesktopNotification): boolean => notifier.publishDesktopEvent(event, (): boolean => this.watch === watch),
      ready: (): void => {
        notifier.reconcile(hostId, (delivered: NotificationIdentity[]): Promise<NotificationIdentity[]> => readDismissals(client, delivered),
          (): boolean => this.watch === watch).catch(() => {});
      },
      dismiss: (identity: NotificationIdentity): void => { notifier.dismiss(hostId, identity).catch(() => {}); },
      logSink: (_line: string): void => {}
    });
    if (watch.start()) { this.watch = watch; }
  }

  stop(): void { let watch = this.watch; this.watch = null; watch?.stop(); }

  setViewing(owner: Object, host: string, worktree: string, runtime: string): void {
    this.viewingOwner = owner; this.notifier.setViewing(host, worktree, runtime);
  }

  clearViewing(owner: Object): void {
    if (this.viewingOwner !== owner) { return; }
    this.viewingOwner = null; this.notifier.setViewing('', '');
  }
}
