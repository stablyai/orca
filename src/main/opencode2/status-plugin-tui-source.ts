import { getTuiStatusDeliverySource } from '../opencode/status-plugin-delivery-source'

// Report from each TUI’s own PTY and current session data so ownership and reconnects self-correct.
export function getOpenCode2TuiSource(): string[] {
  return String.raw`
const TUI_TICK_MS = 100;
const TUI_PERMISSION_SETTLE_MS = 500;
const TUI_EARLY_ROOTS_MAX = 32;
const TUI_RESOLVED_REQUESTS_MAX = 256;
const TUI_ENDPOINT_CHECK_TICKS = 50;

function isOpenCode2TuiContext(ctx) {
  return typeof ctx?.ui?.router?.current === "function" && typeof ctx?.data?.listen === "function";
}

function boundedSet(set, value, max) {
  set.delete(value);
  set.add(value);
  if (set.size > max) set.delete(set.values().next().value);
}

// Memory survives hot reload within this TUI process.
function paneStatusMemory(ctx) {
  const initial = { owned: [], last: "idle:", lastRoot: "", started: false, endings: [] };
  if (typeof ctx.storage?.memory === "function") return ctx.storage.memory("pane-status", { initial });
  // Without memory, reload resembles startup; avoid resetting the pane.
  const local = { ...initial, started: true };
  return [local, (mutate) => mutate(local)];
}

async function setupOpenCode2Tui(ctx) {
  const noop = async () => {};
  // Outside an Orca pane, post has no pane identity to report.
  if (!process.env.ORCA_PANE_KEY) return noop;
  if (process.env.ORCA_OPENCODE_AGENT && process.env.ORCA_OPENCODE_AGENT !== ORCA_STATUS_AGENT) return noop;
  if (/^1\./.test(String(ctx.app?.version || "")) && !ctx.legacyOpenCodeTui) return noop;
  const data = ctx.data.session;
  if (typeof data?.status !== "function" || typeof data.root !== "function") return noop;
  let factoryID;
  try {
    const [memory, setMemory] = paneStatusMemory(ctx);
    factoryID = ++nextFactoryID;
    activeFactoryIDs.add(factoryID);
    let disposed = false;
    let lastLevel = null;
    let ticks = 0;
    const early = new Map();
    // Reconnect fetches may arrive after reply events; do not resurrect retired blockers.
    const resolved = new Set();
    const permissionSeenAt = new Map();

    const rootOf = (sessionID) => data.root(sessionID) || sessionID;
    const family = (root) => new Set([root, ...(typeof data.family === "function" ? data.family(root) || [] : [])]);
    const running = (root) => [...family(root)].some((id) => data.status(id) === "running");
    const currentRoute = () => {
      const route = ctx.ui.router.current();
      return route?.type === "session" && typeof route.sessionID === "string" ? rootOf(route.sessionID) : undefined;
    };
    const blocker = (root, seenPermissions) => {
      let form;
      for (const member of family(root)) {
        const permission = (data.permission?.list?.(member) || []).find((request) => {
          if (resolved.has(request.id)) return false;
          seenPermissions.add(request.id);
          if (!permissionSeenAt.has(request.id)) permissionSeenAt.set(request.id, Date.now());
          // Auto replies follow requests; only unanswered requests need attention.
          return Date.now() - permissionSeenAt.get(request.id) >= TUI_PERMISSION_SETTLE_MS;
        });
        if (permission) return { request: permission, isPermission: true };
        form ??= (data.form?.list?.(member) || []).find((request) => !resolved.has(request.id));
      }
      return form ? { request: form, isPermission: false } : null;
    };
    const levelKey = (level) =>
      (level.kind === "waiting" ? "waiting:" + level.blocker.request.id + ":" + level.root : level.kind + ":" + level.root) +
      (level.rootFields.root_state ? ":" + JSON.stringify(level.rootFields) : "");

    function rootFields(level) {
      if (!level.root) return {};
      const rootRunning = data.status(level.root) === "running";
      const rootState = rootRunning
        ? level.kind === "waiting" && level.blocker.request.sessionID === level.root ? "waiting" : "working"
        : "done";
      const session = data.get?.(level.root);
      const ending = (memory.endings || []).find(([id]) => id === level.root);
      const idleAt = session?.time?.idle;
      const sameTurn = Number.isFinite(idleAt) && ending?.[2] === idleAt;
      // Current session data repairs turns missed while the plugin was unloaded.
      const errorName = !rootRunning && (session?.outcome === "failed"
        ? (sameTurn && ending[1]) || "UnknownError"
        : session?.outcome === "interrupted" && sameTurn ? ending[1] : "");
      return { root_state: rootState, ...(errorName ? { root_turn_error_name: errorName } : {}) };
    }

    function own(root, owned) {
      const seen = early.get(root);
      early.delete(root);
      if (seen?.created) void enqueueLifecycle(() => post("SessionStart", { sessionID: root }));
      if (seen?.prompt) postPrompt(root, seen.prompt);
      return [...owned, root];
    }

    // Derive from current session data so reconnects self-correct without latched start/end events.
    function derive() {
      const route = currentRoute();
      let owned = [...memory.owned];
      if (route && !owned.includes(route) && running(route)) owned = own(route, owned);
      // Retain roots after navigation so turns started here can still reach Done.
      owned = owned.filter((root) => root === route || running(root));
      if (owned.join("\n") !== memory.owned.join("\n")) setMemory((draft) => { draft.owned = owned; });
      const active = owned.filter(running);
      const seenPermissions = new Set();
      let waiting;
      for (const root of active) {
        // Session data can retain stale blockers after a turn ends; consider only running turns.
        const found = blocker(root, seenPermissions);
        if (found && !waiting) waiting = { kind: "waiting", root, blocker: found };
      }
      for (const id of permissionSeenAt.keys()) {
        if (!seenPermissions.has(id)) permissionSeenAt.delete(id);
      }
      if (waiting) return waiting;
      const busy = active.at(-1);
      return busy ? { kind: "busy", root: busy } : { kind: "idle", root: memory.lastRoot };
    }

    function publish() {
      if (disposed) return;
      if (ctx.legacyOpenCodeTui && resolveHookCoords().openCodeTui !== "1") return;
      let level;
      try {
        level = derive();
        level.rootFields = rootFields(level);
      } catch {
        // Session-data read failures must not kill the listener or tick.
        return;
      }
      const key = levelKey(level);
      if (key === memory.last) return;
      setMemory((draft) => {
        draft.last = key;
        if (level.kind !== "idle") draft.lastRoot = level.root;
      });
      lastLevel = level;
      void enqueueLifecycle(() => deliver(level, true));
    }

    async function deliver(level, changed) {
      // Retire assistant previews queued under the old level.
      if (changed) stateArrivalRevision += 1;
      const properties = level.root ? { sessionID: level.root, ...level.rootFields } : {};
      if (level.kind === "waiting") {
        const { request, isPermission } = level.blocker;
        const translated = ctx.legacyOpenCodeTui ? { properties: request } : isPermission
          ? translateOpenCode2Event("permission.asked", request)
          : translateOpenCode2Event("form.created", { form: request });
        if (!translated) return;
        const hookEventName = isPermission ? "PermissionRequest" : "AskUserQuestion";
        await flushPendingAssistantPart(true);
        await setDeliveryTarget("waiting", levelKey(level), hookEventName, { ...translated.properties, ...properties }, factoryID);
        return;
      }
      if (level.kind === "idle") await flushPendingAssistantPart(true);
      await setDeliveryTarget(level.kind, levelKey(level), level.kind === "busy" ? "SessionBusy" : "SessionIdle", properties, factoryID);
    }

    function postPrompt(root, prompt) {
      void enqueueLifecycle(() =>
        postMessagePart({ role: "user", text: capMessagePartText(prompt.text), messageID: prompt.messageID, sessionID: root }, factoryID),
      );
    }

    function remember(root, update) {
      const seen = { ...(early.get(root) || {}), ...update };
      early.delete(root);
      early.set(root, seen);
      if (early.size > TUI_EARLY_ROOTS_MAX) early.delete(early.keys().next().value);
    }

    function observe(event) {
      const properties = event.data || {};
      const sessionID = properties.sessionID;
      if (event.type === "server.connected") {
        // OpenCode resyncs only displayed sessions; refetch owned sessions to clear disconnected replies.
        for (const root of memory.owned) {
          for (const member of family(root)) {
            void data.permission?.sync?.(member)?.catch?.(() => {});
            void data.form?.sync?.(member)?.catch?.(() => {});
          }
        }
        return;
      }
      if (event.type === "permission.replied") return boundedSet(resolved, properties.requestID, TUI_RESOLVED_REQUESTS_MAX);
      if (event.type === "form.replied" || event.type === "form.cancelled") {
        return boundedSet(resolved, properties.id, TUI_RESOLVED_REQUESTS_MAX);
      }
      if (typeof sessionID !== "string" || !sessionID) return;
      if (event.type === "session.deleted") {
        early.delete(sessionID);
        if (memory.owned.includes(sessionID)) {
          setMemory((draft) => { draft.owned = draft.owned.filter((id) => id !== sessionID); });
        }
        return;
      }
      if (event.type === "session.created") {
        if (!properties.parentID) remember(sessionID, { created: true });
        return;
      }
      const root = rootOf(sessionID);
      const isOwned = memory.owned.includes(root);
      if (ctx.legacyOpenCodeTui && event.type === "message.part.updated") {
        const part = properties.part;
        const role = messageRoleById.get(part?.messageID);
        if (sessionID !== root || part?.type !== "text" || part.synthetic === true || typeof part.text !== "string" || !part.text || memory.last.startsWith("waiting:")) return;
        if (role === "user") {
          const prompt = { text: part.text, messageID: part.messageID };
          if (isOwned) postPrompt(root, prompt); else remember(root, { prompt });
        } else if (role === "assistant" && isOwned) {
          void enqueueLifecycle(() => queueAssistantPart({ role, text: part.text, messageID: part.messageID, sessionID: root, factoryID, authorityRevision: stateArrivalRevision }));
        }
        return;
      }
      if (sessionID === root && (isOwned || currentRoute() === root)) {
        if (event.type === "session.execution.started" || event.type === "session.execution.succeeded" || event.type === "session.execution.failed" || event.type === "session.execution.interrupted") {
          const errorName = event.type === "session.execution.failed"
            ? (typeof properties.error?.type === "string" && properties.error.type) || "UnknownError"
            : event.type === "session.execution.interrupted" && properties.reason === "user" ? "MessageAbortedError" : "";
          // Hot reload preserves terminal verdicts until this root starts another turn.
          setMemory((draft) => {
            draft.endings = (draft.endings || []).filter(([id]) => id !== root);
            if (errorName) draft.endings = [...draft.endings, [root, errorName, event.created ?? data.get?.(root)?.time?.idle]].slice(-TUI_EARLY_ROOTS_MAX);
          });
        }
      }
      if (event.type === "session.inbox.enqueued") {
        // TUI lacks the server's session.hook prompt callback.
        const item = properties.item;
        if (sessionID !== root || item?.type !== "user" || typeof item.payload?.text !== "string" || !item.payload.text) return;
        const prompt = { text: item.payload.text, messageID: properties.inboxID };
        if (!isOwned) return remember(root, { prompt });
        if (!memory.last.startsWith("waiting:")) postPrompt(root, prompt);
        return;
      }
      if (event.type === "session.text.ended" && isOwned && sessionID === root && typeof properties.text === "string" && properties.text) {
        // MessagePart implies Working in Orca and must not bury Needs input.
        if (memory.last.startsWith("waiting:")) return;
        const part = { role: "assistant", text: properties.text, messageID: properties.assistantMessageID, sessionID: root, factoryID };
        // Queue reply previews after this turn's start, prompt and Busy.
        void enqueueLifecycle(() => queueAssistantPart({ ...part, authorityRevision: stateArrivalRevision }));
      }
    }

    // OpenCode updates data before listeners; derive synchronously to avoid stale event queues.
    const unsubscribe = ctx.data.listen(({ details } = {}) => {
      if (disposed || !details || typeof details.type !== "string") return;
      try {
        observe(details);
        publish();
      } catch {
        // Malformed events must not break the listener.
      }
    });
    // Route changes and reconnect rehydration can happen without events.
    const tick = setInterval(() => {
      try {
        publish();
        // Ticks must request unchanged-level reposting when Orca restarts and moves the endpoint.
        if (++ticks % TUI_ENDPOINT_CHECK_TICKS === 0 && lastLevel && desiredFactoryID === factoryID && deliveredEndpointKey !== hookEndpointKey()) {
          const level = lastLevel;
          void enqueueLifecycle(() => deliver(level, false));
        }
      } catch {}
    }, TUI_TICK_MS);
    if (tick.unref) tick.unref();
    publish();
    if (!memory.started) {
      setMemory((draft) => { draft.started = true; });
      // Fresh starts clear prior-process status with connected idle; reloads retain the terminal verdict.
      if (memory.last === "idle:") {
        const route = currentRoute();
        void enqueueLifecycle(() => post("SessionStart", route ? { sessionID: route } : {}));
      }
    }
    return async () => {
      try {
        disposed = true;
        clearInterval(tick);
        if (typeof unsubscribe === "function") unsubscribe();
        // Hot reload rederives memory and unconfirmed delivery in the next generation; publish nothing.
        await releaseTuiStatusDelivery(factoryID, () => setMemory((draft) => { draft.last = ""; }));
      } catch {
        // Cleanup failures must not fail plugin unload.
      }
    };
  } catch {
    if (factoryID !== undefined) activeFactoryIDs.delete(factoryID);
    return noop;
  }
}

`
    .split('\n')
    .concat(getTuiStatusDeliverySource())
}
