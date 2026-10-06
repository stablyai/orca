import { getTuiStatusDeliverySource } from '../opencode/status-plugin-delivery-source'

/**
 * TUI reporter for the OpenCode 2 status plugin. The module Orca writes as a server plugin is
 * also installed as a TUI plugin; in a TUI process setup() lands here. The TUI runs in its
 * pane's PTY, so every post names the right pane. It derives the pane's level from the TUI's
 * own session data (which OpenCode keeps current, re-hydrating it on reconnect) instead of
 * inferring it from events, and reuses only the plugin's delivery functions.
 */
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

// Memory survives hot reloads and ends with the TUI.
function paneStatusMemory(ctx) {
  const initial = { owned: [], last: "idle:", lastRoot: "", started: false, endings: [] };
  if (typeof ctx.storage?.memory === "function") return ctx.storage.memory("pane-status", { initial });
  // Why started: without memory a reload looks like a TUI start, and must not reset the pane.
  const local = { ...initial, started: true };
  return [local, (mutate) => mutate(local)];
}

async function setupOpenCode2Tui(ctx) {
  const noop = async () => {};
  // Why: post() needs this pane's key, so a TUI outside an Orca pane has nothing to report.
  if (!process.env.ORCA_PANE_KEY) return noop;
  if (process.env.ORCA_OPENCODE_AGENT && process.env.ORCA_OPENCODE_AGENT !== ORCA_STATUS_AGENT) return noop;
  // Legacy attach contexts enter only through the checked API adapter.
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
    // Why: a permission/form list fetched on reconnect can land after the reply event and restore it.
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
          // Auto replies arrive after the request; only an unanswered request needs attention.
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
      // Current session data repairs a whole turn missed while the plugin was unloaded.
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

    // Why derive, not infer: OpenCode's session data is the single copy of running/blocked/lineage
    // and self-corrects on reconnect; nothing here latches a start or end event.
    function derive() {
      const route = currentRoute();
      let owned = [...memory.owned];
      if (route && !owned.includes(route) && running(route)) owned = own(route, owned);
      // Why keep a root past navigation: a pane that started a turn must still reach Done
      // when the user browses to another session mid-turn.
      owned = owned.filter((root) => root === route || running(root));
      if (owned.join("\n") !== memory.owned.join("\n")) setMemory((draft) => { draft.owned = owned; });
      const active = owned.filter(running);
      const seenPermissions = new Set();
      let waiting;
      for (const root of active) {
        // Why only while running: a blocker the session data kept after its turn ended is stale.
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
        // Why: a data read that throws must not kill the listener or the tick.
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
      // Retires assistant text queued under the previous level (see flushPendingAssistantPart).
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

    // Content only; status comes from derive().
    function observe(event) {
      const properties = event.data || {};
      const sessionID = properties.sessionID;
      if (event.type === "server.connected") {
        // Why: OpenCode re-syncs blockers only for the sessions it displays; an owned session the
        // user navigated away from would otherwise keep a request answered while disconnected.
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
          // A hot reload keeps the terminal verdict; only this root's next turn replaces it.
          setMemory((draft) => {
            draft.endings = (draft.endings || []).filter(([id]) => id !== root);
            if (errorName) draft.endings = [...draft.endings, [root, errorName, event.created ?? data.get?.(root)?.time?.idle]].slice(-TUI_EARLY_ROOTS_MAX);
          });
        }
      }
      if (event.type === "session.inbox.enqueued") {
        // Why TUI-only: the server takes the prompt from session.hook("prompt"), which a TUI lacks.
        const item = properties.item;
        if (sessionID !== root || item?.type !== "user" || typeof item.payload?.text !== "string" || !item.payload.text) return;
        const prompt = { text: item.payload.text, messageID: properties.inboxID };
        if (!isOwned) return remember(root, { prompt });
        if (!memory.last.startsWith("waiting:")) postPrompt(root, prompt);
        return;
      }
      if (event.type === "session.text.ended" && isOwned && sessionID === root && typeof properties.text === "string" && properties.text) {
        // Why: Orca reads any MessagePart as Working, which would bury this pane's Needs input.
        if (memory.last.startsWith("waiting:")) return;
        const part = { role: "assistant", text: properties.text, messageID: properties.assistantMessageID, sessionID: root, factoryID };
        // Why queued: the reply must not overtake this turn's SessionStart, prompt or Busy.
        void enqueueLifecycle(() => queueAssistantPart({ ...part, authorityRevision: stateArrivalRevision }));
      }
    }

    // Why synchronous: OpenCode applies each event to its session data before plugin listeners
    // run, so deciding here never trails the data, and no queue of events can build up.
    const unsubscribe = ctx.data.listen(({ details } = {}) => {
      if (disposed || !details || typeof details.type !== "string") return;
      try {
        observe(details);
        publish();
      } catch {
        // A malformed event must not break the listener.
      }
    });
    // Why a tick: a route change has no event, and a reconnect re-hydrates the data without one.
    const tick = setInterval(() => {
      try {
        publish();
        // Why: an Orca restart moves the hook endpoint; the delivery layer re-posts an unchanged
        // level only when asked, which the old event-driven path did on every lifecycle event.
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
      // Why: clears a status an earlier process left on this pane (e.g. a pre-upgrade shared service
      // posting another pane's turn here). Connected idle, never a completion; reloads skip it.
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
        // Why publish nothing: a hot reload disposes this mid-turn and the next generation
        // re-derives from the same memory. Unconfirmed delivery is re-derived by that generation.
        await releaseTuiStatusDelivery(factoryID, () => setMemory((draft) => { draft.last = ""; }));
      } catch {
        // Why: cleanup runs during plugin unload; a throw here also fails the plugin.
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
