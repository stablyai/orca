import { DesktopNotification } from './LocalNotifier';
import { NotificationIdentity, readNotificationIdentity } from './NotificationIdentity';
/** Live desktop notifications, with session-state fallback for older hosts. */

export interface AgentWatchDeps {
  /** Device token used in the wire frame's deviceToken field (same value SpikeRpcClient authed with). */
  deviceToken: string;
  /** Host id handed to notify() for deep-link attribution. */
  hostId: string;
  /** Optional: subscribe to one worktree instead of all ('id:<worktreeId>' or an alias). */
  worktreeSelector?: string;
  /** Wire the pre-built subscribe frame under a caller-chosen id (SpikeRpcClient.subscribeWithId). */
  subscribe: (id: string, wire: string, onEvent: (responseJson: string) => void) => boolean;
  /** Drop the stream handler (SpikeRpcClient.cancelById). */
  cancel: (id: string) => void;
  /** Publish a local notification (LocalNotifier.publishAgentEvent). */
  notify: (title: string, body: string, hostId: string, worktreeId: string, paneKey?: string, executionHost?: string) => boolean;
  notifyEvent?: (event: DesktopNotification) => boolean;
  ready?: () => void;
  dismiss?: (identity: NotificationIdentity) => void;
  logSink: (line: string) => void;
}

const STATE_DONE = 'done';
const STATE_WAITING = 'waiting';
const PROMPT_PREVIEW_MAX = 120;

export class AgentWatch {
  private deps: AgentWatchDeps;
  private subscriptionId: string = '';
  private active: boolean = false;
  private seenNotifications: Set<string> = new Set();
  private legacy = false;
  /** Last known agent state per "<worktreeId>/<tabId>"; '' baseline means "never notify on first sight". */
  private lastStates: Map<string, string> = new Map();

  constructor(deps: AgentWatchDeps) {
    this.deps = deps;
  }

  /**
   * Sends the subscribe frame. Returns false when the channel is not ready or the
   * send failed; events start arriving asynchronously afterwards.
   */
  start(): boolean {
    if (this.active) {
      return true;
    }
    try {
      this.legacy = false;
      let subId = `watch-${Date.now()}`;
      let params: Record<string, Object> = { 'includeDesktopSuppressed': true };
      let frame: Record<string, Object> = { 'id': subId, 'deviceToken': this.deps.deviceToken, 'method': 'notifications.subscribe', 'params': params };
      let wire = JSON.stringify(frame);
      let ok = this.deps.subscribe(subId, wire, (frame: string): void => {
        this.onFrame(frame);
      });
      if (!ok) {
        this.deps.logSink('agent watch: subscribe 发送失败（通道未就绪？）');
        return false;
      }
      this.subscriptionId = subId;
      this.active = true;
      this.deps.logSink(`agent watch: 已订阅 (${subId})`);
      return true;
    } catch (e) {
      this.deps.logSink(`agent watch 启动异常: ${(e as Error).message}`);
      return false;
    }
  }

  /** Drops the stream handler and clears the last-state map. */
  stop(): void {
    if (this.subscriptionId.length > 0) {
      try {
        this.deps.cancel(this.subscriptionId);
      } catch (e) {
        this.deps.logSink(`agent watch cancel 异常: ${(e as Error).message}`);
      }
    }
    this.subscriptionId = '';
    this.active = false;
    this.lastStates.clear(); this.seenNotifications.clear();
    this.deps.logSink('agent watch: 已停止');
  }

  isActive(): boolean {
    return this.active;
  }

  /** Wire frame mirrors SpikeRpcClient.buildWire key order: id, deviceToken, method, params. */
  private buildSubscribeWire(subId: string): string {
    let selector = this.deps.worktreeSelector ? this.deps.worktreeSelector : '';
    if (selector.length > 0) {
      let params: Record<string, string> = { 'worktree': selector };
      let obj: Record<string, Object> = {
        'id': subId,
        'deviceToken': this.deps.deviceToken,
        'method': 'session.tabs.subscribe',
        'params': params
      };
      return JSON.stringify(obj);
    }
    let obj: Record<string, Object> = {
      'id': subId,
      'deviceToken': this.deps.deviceToken,
      'method': 'session.tabs.subscribeAll'
    };
    return JSON.stringify(obj);
  }

  private onFrame(frameJson: string): void {
    if (!this.active) { return; }
    try {
      let parsed: Object | null = JSON.parse(frameJson) as Object | null;
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return;
      }
      let rec = parsed as Record<string, Object>;
      // Stream events arrive as {"id","streaming":true,"result":<event>}; fall back to
      // the top-level frame when a host spells it differently.
      let error: ESObject = rec['error'];
      if (!this.legacy && error && ['method-not-found', 'method_not_found', 'unknown_method', '-32601'].includes(String(error.code))) {
        this.legacy = true;
        this.deps.cancel(this.subscriptionId);
        let wire = this.buildSubscribeWire(this.subscriptionId);
        this.deps.subscribe(this.subscriptionId, wire, (frame: string): void => this.onFrame(frame));
        return;
      }
      let eventSource: Object = rec;
      let streamingValue: Object = rec['streaming'];
      if (streamingValue === true) {
        let resultValue: Object = rec['result'];
        if (resultValue === null || resultValue === undefined || typeof resultValue !== 'object'
          || Array.isArray(resultValue)) {
          return;
        }
        eventSource = resultValue;
      }
      let event = eventSource as Record<string, Object>;
      let typeValue: Object = event['type'];
      if (typeof typeValue !== 'string') {
        return;
      }
      if (typeValue === 'ready') { if (!this.legacy) { this.deps.ready?.(); } return; }
      if (typeValue === 'dismiss') {
        let identity = readNotificationIdentity(event['dismissedDelivery'] ?? event);
        if (identity) { this.deps.dismiss?.(identity); }
        return;
      }
      if (typeValue === 'notification') { this.onNotification(event); return; }
      if (typeValue === 'end') {
        this.deps.logSink('agent watch: 流已结束（type=end）');
        return;
      }
      if (typeValue === 'snapshots') {
        let snapshotsValue: Object = event['snapshots'];
        if (snapshotsValue !== null && snapshotsValue !== undefined && Array.isArray(snapshotsValue)) {
          let snapshots = snapshotsValue as Array<Object>;
          for (let i = 0; i < snapshots.length; i++) {
            this.onSnapshot(snapshots[i]);
          }
        }
        return;
      }
      if (typeValue === 'snapshot' || typeValue === 'updated') {
        this.onSnapshot(event);
        return;
      }

    } catch (e) {
      this.deps.logSink(`agent watch 事件解析失败: ${(e as Error).message}`);
    }
  }

  /** One per-worktree snapshot/updated frame: {worktree, tabs:[...]}. */
  private onSnapshot(snapshotValue: Object): void {
    if (snapshotValue === null || snapshotValue === undefined || typeof snapshotValue !== 'object'
      || Array.isArray(snapshotValue)) {
      return;
    }
    let snapshot = snapshotValue as Record<string, Object>;
    let worktreeValue: Object = snapshot['worktree'];
    let worktreeId = typeof worktreeValue === 'string' ? worktreeValue : '';
    let tabsValue: Object = snapshot['tabs'];
    if (tabsValue === null || tabsValue === undefined || !Array.isArray(tabsValue)) {
      return;
    }
    let tabs = tabsValue as Array<Object>;
    let seenKeys: string[] = [];
    for (let i = 0; i < tabs.length; i++) {
      let key = this.onTab(tabs[i], worktreeId);
      if (key.length > 0) {
        seenKeys.push(key);
      }
    }
    // Full-array frames are authoritative: drop state for tabs that disappeared.
    if (worktreeId.length > 0) {
      let prefix = `${worktreeId}/`;
      let stale: string[] = [];
      this.lastStates.forEach((value: string, key: string): void => {
        if (key.startsWith(prefix) && !seenKeys.includes(key)) {
          stale.push(key);
        }
      });
      for (let i = 0; i < stale.length; i++) {
        this.lastStates.delete(stale[i]);
      }
    }
  }

  private onNotification(event: Record<string, Object>): void {
    let source = this.readStringMember(event, 'source');
    if (event['desktopAllowed'] === false || !['agent-task-complete', 'terminal-bell', 'plugin'].includes(source)) { return; }
    let title = this.readStringMember(event, 'title'); let body = this.readStringMember(event, 'body');
    let epoch = this.readStringMember(event, 'notificationEpoch'); let sequence = event['notificationSeq'];
    if (typeof event['title'] !== 'string' || typeof event['body'] !== 'string' || epoch.length === 0 || epoch.length > 128
      || typeof sequence !== 'number' || !Number.isSafeInteger(sequence) || sequence < 0) { return; }
    let state = this.readStringMember(event, 'agentState');
    if (source === 'agent-task-complete' && state && !['done', 'finished', 'blocked', 'waiting', 'needs-input'].includes(state)) { return; }
    let identity = `${epoch}/${sequence}`; if (this.seenNotifications.has(identity)) { return; }
    this.seenNotifications.add(identity);
    if (this.seenNotifications.size > 128) { let first = Array.from(this.seenNotifications)[0]; this.seenNotifications.delete(first); }
    if (this.deps.notifyEvent) {
      let emittedAt = event['emittedAt'];
      this.deps.notifyEvent({ title: this.clipAlertText(title, 80), body: this.clipAlertText(body, 180),
        hostId: this.deps.hostId, worktreeId: this.readStringMember(event, 'worktreeId'), paneKey: this.readStringMember(event, 'paneKey'),
        executionHost: this.readStringMember(event, 'executionHost'), source: source, agentState: state,
        desktopAway: typeof event['desktopAway'] === 'boolean' ? event['desktopAway'] as boolean : null,
        identity: readNotificationIdentity(event), attentionKey: this.readStringMember(event, 'attentionKey'),
        emittedAt: typeof emittedAt === 'number' && Number.isFinite(emittedAt) ? emittedAt : undefined });
      return;
    }
    this.deps.notify(this.clipAlertText(title, 80), this.clipAlertText(body, 180), this.deps.hostId,
      this.readStringMember(event, 'worktreeId'), this.readStringMember(event, 'paneKey'), this.readStringMember(event, 'executionHost'));
  }

  private clipAlertText(value: string, max: number): string {
    let normalized = value.replace(/\s+/g, ' ').trim();
    return normalized.length <= max ? normalized : `${normalized.slice(0, max - 1)}…`;
  }

  /** Reads one tab loosely; returns the state key it recorded ('' when nothing usable). */
  private onTab(tabValue: Object, worktreeId: string): string {
    if (tabValue === null || tabValue === undefined || typeof tabValue !== 'object'
      || Array.isArray(tabValue)) {
      return '';
    }
    let tab = tabValue as Record<string, Object>;
    let tabIdValue: Object = tab['id'];
    if (typeof tabIdValue !== 'string' || tabIdValue.length === 0) {
      return '';
    }
    let worktree = worktreeId;
    if (worktree.length === 0) {
      let tabWorktreeValue: Object = tab['worktreeId'];
      if (typeof tabWorktreeValue === 'string') {
        worktree = tabWorktreeValue;
      }
    }
    let key = `${worktree}/${tabIdValue}`;
    let state = this.readTabState(tab);
    this.maybeNotify(tab, worktree, key, state);
    this.lastStates.set(key, state);
    return key;
  }

  /**
   * Loose state read: terminal tabs -> agentStatus.state; agent-session tabs ->
   * chatStatus.state; anything else falls back to a top-level tab.state. Unknown
   * shapes yield '' (treated as "not an agent tab").
   */
  private readTabState(tab: Record<string, Object>): string {
    let agent: ESObject = tab['agentStatus'];
    if (agent && typeof agent === 'object' && typeof agent.interactivePrompt === 'string' && agent.interactivePrompt.length > 0) { return STATE_WAITING; }
    let fromAgentStatus = this.readStateOfObject(tab['agentStatus']);
    if (fromAgentStatus.length > 0) {
      return fromAgentStatus === 'blocked' ? STATE_WAITING : fromAgentStatus;
    }
    let fromChatStatus = this.readStateOfObject(tab['chatStatus']);
    if (fromChatStatus.length > 0) {
      return fromChatStatus === 'blocked' ? STATE_WAITING : fromChatStatus;
    }
    return this.readStateOfObject(tab['state']);
  }

  private readStateOfObject(value: Object): string {
    if (typeof value === 'string') { return value; }
    if (value === null || value === undefined || typeof value !== 'object' || Array.isArray(value)) {
      return '';
    }
    let obj = value as Record<string, Object>;
    let stateValue: Object = obj['state'];
    return typeof stateValue === 'string' ? stateValue : '';
  }

  private readStringMember(obj: Record<string, Object>, name: string): string {
    let value: Object = obj[name];
    return typeof value === 'string' ? value : '';
  }

  /**
   * Fires notifications on transitions only (never on a tab's first sighting, which is
   * the baseline after (re)subscribe): non-done -> done, and anything -> waiting /
   * interactivePrompt appearing ("needs input").
   */
  private maybeNotify(tab: Record<string, Object>, worktreeId: string, key: string, state: string): void {
    try {
      let previous = this.lastStates.get(key);
      if (previous === undefined || previous.length === 0) {
        return;
      }
      let titleValue: Object = tab['title'];
      let title = typeof titleValue === 'string' && titleValue.length > 0 ? titleValue : 'Agent';
      let promptPreview = '';
      let interactive = false;
      let agentStatusValue: Object = tab['agentStatus'];
      if (agentStatusValue !== null && agentStatusValue !== undefined
        && typeof agentStatusValue === 'object' && !Array.isArray(agentStatusValue)) {
        let agentStatus = agentStatusValue as Record<string, Object>;
        promptPreview = this.readStringMember(agentStatus, 'prompt');
        interactive = this.readStringMember(agentStatus, 'interactivePrompt').length > 0;
        if (promptPreview.length === 0) {
          promptPreview = this.readStringMember(agentStatus, 'interactivePrompt');
        }
      }
      if (promptPreview.length > PROMPT_PREVIEW_MAX) {
        promptPreview = promptPreview.slice(0, PROMPT_PREVIEW_MAX);
      }
      if (previous !== STATE_DONE && state === STATE_DONE) {
        let body = promptPreview.length > 0 ? `最近输入: ${promptPreview}` : '本轮任务已完成';
        this.notifyTransition(`${title} 已完成`, body, worktreeId, tab, 'done');
        return;
      }
      if (previous !== STATE_WAITING && (state === STATE_WAITING || interactive)) {
        this.notifyTransition(`${title} 需要输入`, promptPreview.length > 0 ? promptPreview : 'Agent 正在等待你的回复',
          worktreeId, tab, 'waiting');
      }
    } catch (e) {
      this.deps.logSink(`agent watch notify 异常: ${(e as Error).message}`);
    }
  }
  private notifyTransition(title: string, body: string, worktreeId: string, tab: Record<string, Object>, state: string): void {
    if (this.deps.notifyEvent) {
      this.deps.notifyEvent({ title: title, body: body, hostId: this.deps.hostId, worktreeId: worktreeId,
        paneKey: this.readStringMember(tab, 'paneKey'), executionHost: this.readStringMember(tab, 'executionHost'),
        source: 'agent-task-complete', agentState: state, desktopAway: null, identity: null });
    } else { this.deps.notify(title, body, this.deps.hostId, worktreeId); }
  }

}
