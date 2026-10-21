/** Adapts the genuine 1.x TUI API to the existing structural pane reporter. */
export function getLegacyOpenCodeTuiSource(): string[] {
  return String.raw`
async function setupLegacyOpenCodeTui(api) {
  const noop = async () => {};
  if (!/^1\./.test(String(api?.app?.version || "")) || !process.argv.includes("attach")) return noop;
  const session = api.state?.session;
  if (typeof session?.get !== "function" || typeof session.status !== "function" || typeof api.event?.on !== "function") return noop;
  reportingOpenCodeTui = true;
  const root = (id) => {
    const visited = [];
    let current = id;
    while (visited.length < MAX_SESSION_ANCESTRY_DEPTH && !visited.includes(current)) {
      visited.push(current);
      const parent = session.get(current)?.parentID;
      if (!parent) {
        for (const member of visited) rememberSessionRoot(member, current);
        return current;
      }
      current = parent;
    }
    return undefined;
  };
  const eventTypes = ["session.created", "session.deleted", "session.status", "session.idle", "session.error", "message.updated", "message.part.updated", "permission.asked", "permission.replied", "question.asked", "question.replied", "question.rejected", "server.connected"];
  const ctx = {
    app: api.app,
    legacyOpenCodeTui: true,
    ui: { router: { current: () => {
      const route = api.route.current;
      return route?.name === "session" ? { type: "session", sessionID: route.params?.sessionID } : { type: "home" };
    } } },
    data: {
      session: {
        get: (id) => session.get(id),
        root,
        family: (id) => [...rootSessionById.keys()].filter((member) => member !== id && root(member) === id),
        status: (id) => {
          const type = session.status(id)?.type;
          return type === "busy" || type === "retry" ? "running" : "idle";
        },
        permission: { list: (id) => session.permission(id) },
        form: { list: (id) => session.question(id) },
      },
      listen: (listener) => {
        const unsubscribers = eventTypes.map((type) => api.event.on(type, (input) => {
          const event = input?.details || input;
          const properties = event?.properties || {};
          const infoSessionID = type === "session.created" || type === "session.deleted" ? properties.info?.id : properties.info?.sessionID;
          const sessionID = properties.sessionID || infoSessionID || properties.part?.sessionID;
          if (sessionID) root(sessionID);
          if (type === "message.updated") rememberMessageRole(properties.info?.id, properties.info?.role);
          listener({ details: { type, data: { ...properties, sessionID, ...(type === "session.created" ? properties.info : {}) } } });
        }));
        return () => unsubscribers.forEach((unsubscribe) => { if (typeof unsubscribe === "function") unsubscribe(); });
      },
    },
  };
  const dispose = await setupOpenCode2Tui(ctx);
  api.lifecycle?.onDispose?.(dispose);
  return dispose;
}
`.split('\n')
}
