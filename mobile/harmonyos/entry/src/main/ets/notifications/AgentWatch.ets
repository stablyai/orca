/**
 * Agent state watcher (Phase 4a): subscribes to the host's session-tabs stream on an
 * already-connected RPC channel and turns agent state transitions into local
 * notifications.
 *
 * Upstream contract (src/main/runtime/rpc/methods/session-tabs/session-tabs.ts):
 * - 'session.tabs.subscribe' requires params {"worktree": "<selector>"} (min length 1);
 *   'session.tabs.subscribeAll' takes no params and streams every worktree. The default
 *   here is subscribeAll (watch the whole host); pass worktreeSelector to switch to the
 *   single-worktree subscribe method.
 * - Stream events ride in frames {"id","streaming":true,"result":<event>}; the event is
 *   {"type":"snapshot"|"updated","worktree","tabs":[...]} (single) or
 *   {"type":"snapshots","snapshots":[...]}, and {"type":"end"} on teardown.
 * - Without the tab-delta client capability (SpikeRpcClient sends none) every frame
 *   carries the full tabs array.
 * - Tab agent state (loose, per upstream AGENT_STATUS_STATES): terminal tabs carry
 *   agentStatus.state in 'working' | 'blocked' | 'waiting' | 'done'; agent-session tabs
 *   may carry chatStatus instead; waiting/interactivePrompt signals "needs input".
 *   There is no 'finished' literal on the wire — 'done' is the finished state, so the
 *   notification rule is non-done -> done, plus waiting transitions.
 *
 * Everything here parses defensively: unknown shapes are logged and skipped, never thrown.
 */

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
  notify: (title: string, body: string, hostId: string, worktreeId: string) => boolean;
  logSink: (line: string) => void;
}

const STATE_DONE = 'done';
const STATE_WAITING = 'waiting';
const PROMPT_PREVIEW_MAX = 120;

export class AgentWatch {
  private deps: AgentWatchDeps;
  private subscriptionId: string = '';
  private active: boolean = false;
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
      let subId = `watch-${Date.now()}`;
      let wire = this.buildSubscribeWire(subId);
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
    this.lastStates.clear();
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
    try {
      let parsed: Object | null = JSON.parse(frameJson) as Object | null;
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return;
      }
      let rec = parsed as Record<string, Object>;
      // Stream events arrive as {"id","streaming":true,"result":<event>}; fall back to
      // the top-level frame when a host spells it differently.
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
      // Unknown frame types are ignored on purpose (loose handling).
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
    let fromAgentStatus = this.readStateOfObject(tab['agentStatus']);
    if (fromAgentStatus.length > 0) {
      return fromAgentStatus;
    }
    let fromChatStatus = this.readStateOfObject(tab['chatStatus']);
    if (fromChatStatus.length > 0) {
      return fromChatStatus;
    }
    return this.readStateOfObject(tab['state']);
  }

  private readStateOfObject(value: Object): string {
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
        this.deps.notify(`${title} 已完成`, body, this.deps.hostId, worktreeId);
        return;
      }
      if (previous !== STATE_WAITING && (state === STATE_WAITING || interactive)) {
        this.deps.notify(`${title} 需要输入`, promptPreview.length > 0 ? promptPreview : 'Agent 正在等待你的回复',
          this.deps.hostId, worktreeId);
      }
    } catch (e) {
      this.deps.logSink(`agent watch notify 异常: ${(e as Error).message}`);
    }
  }
}
