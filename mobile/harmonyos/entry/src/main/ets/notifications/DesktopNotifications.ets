import { common } from '@kit.AbilityKit';
import { SpikeRpcClient } from '../transport/SpikeRpcClient';
import { AgentWatch } from './AgentWatch';
import { DesktopNotification, LocalNotifier } from './LocalNotifier';

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
      notifyEvent: (event: DesktopNotification): boolean => notifier.publishDesktopEvent(event),
      dismiss: (id: string): void => { notifier.dismiss(id).catch(() => {}); },
      logSink: (_line: string): void => {}
    });
    if (watch.start()) { this.watch = watch; }
  }

  stop(): void { this.watch?.stop(); this.watch = null; }

  setViewing(owner: Object, host: string, worktree: string, runtime: string): void {
    this.viewingOwner = owner; this.notifier.setViewing(host, worktree, runtime);
  }

  clearViewing(owner: Object): void {
    if (this.viewingOwner !== owner) { return; }
    this.viewingOwner = null; this.notifier.setViewing('', '');
  }
}
