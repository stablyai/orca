export function getOpenCode2SetupSource(): string[] {
  return String.raw`
// Why: OpenCode owns a form under a session id, and Orca retires a blocker when
// that session goes idle. An owner that is not a real session has no idle, so a
// blocker minted for it can only ever be retired by an exact reply — add an id
// here to drop forms Orca could otherwise strand. OpenCode's own schema calls
// "global" a temporary MCP-elicitation sentinel it intends to replace with real
// session ids; when it does, this set stops matching and those forms block.
const NON_SESSION_FORM_OWNERS = new Set(["global"]);

async function setupOpenCode2Status(ctx) {
  const controller = new AbortController();
  const client = { session: { get: (input, options) => ctx.session.get(input, options) } };
  const hooks = await OrcaOpenCodeStatusPlugin({ client });
  if (!hooks.event) return async () => {};
  const promptRegistration = await ctx.session.hook("prompt", async (properties) => {
    await hooks.event({ event: { type: "session.next.prompt.admitted", properties } });
  });
  const consume = async () => {
    for await (const input of ctx.event.subscribe({ signal: controller.signal })) {
      if (controller.signal.aborted) break;
      let type = input.type;
      let properties = input.data;
      if (type === "session.created") {
        properties = { info: { ...properties, id: properties.sessionID } };
      } else if (type === "session.execution.started") {
        type = "session.status";
        properties = { ...properties, status: { type: "busy" } };
      } else if (type === "session.execution.succeeded" || type === "session.execution.failed" || type === "session.execution.interrupted") {
        type = "session.status";
        properties = { ...properties, status: { type: "idle" } };
      } else if (type === "permission.asked") {
        properties = { ...properties, permission: properties.action, patterns: properties.resources };
      } else if (type === "form.created") {
        const form = properties.form;
        // Why: block on every form whose owner is a real session. "metadata" is
        // optional in OpenCode's schema and its "kind" is a convention no
        // producer is obliged to stamp, so an unknown shape must surface a
        // blocker the user can clear rather than vanish while OpenCode waits.
        if (!form || NON_SESSION_FORM_OWNERS.has(form.sessionID)) continue;
        // A malformed form must not throw: that would kill the subscription.
        const fields = Array.isArray(form.fields) ? form.fields : [];
        type = "question.asked";
        properties = {
          ...form,
          questions: fields.map((field) => ({
            header: field.title || form.title,
            question: field.description || field.title || form.title,
            options: (field.options || []).map((option) => ({ label: option.label || option.value, description: option.description || "" })),
            multiple: field.type === "multiselect",
          })),
        };
      } else if (type === "form.replied" || type === "form.cancelled") {
        // A resolution for an ignored form is inert: the blocker key carries the
        // form id, so it simply matches nothing.
        type = type === "form.replied" ? "question.replied" : "question.rejected";
        properties = { ...properties, requestID: properties.id };
      } else if (type === "session.text.started" || type === "session.text.delta" || type === "session.text.ended") {
        type = type.replace("session.", "session.next.");
      }
      await hooks.event({ event: { type, properties } });
    }
  };
  const consuming = consume().catch((error) => {
    if (!controller.signal.aborted) console.warn("[orca-hook] event subscription failed:", error.message);
  });
  return async () => {
    controller.abort();
    await promptRegistration.dispose();
    await consuming;
    await hooks.dispose();
  };
}
`.split('\n')
}

export function getOpenCode2EventNormalizationSource(): string[] {
  return [
    '',
    'function normalizeNextLifecycleEvent(event) {',
    '  if (!event || typeof event.type !== "string") return event;',
    '  const properties = event.properties || {};',
    '  if (event.type === "permission.v2.asked") return { ...event, type: "permission.asked", properties: { ...properties, id: properties.id, permission: properties.action, patterns: properties.resources } };',
    '  if (event.type === "permission.v2.replied") return { ...event, type: "permission.replied", properties: { ...properties } };',
    '  if (event.type === "question.v2.asked") return { ...event, type: "question.asked", properties: { ...properties } };',
    '  if (event.type === "question.v2.replied") return { ...event, type: "question.replied", properties: { ...properties } };',
    '  if (event.type === "question.v2.rejected") return { ...event, type: "question.rejected", properties: { ...properties } };',
    '  if (event.type === "session.next.step.started" || event.type === "session.next.tool.called" || event.type === "session.next.tool.progress" || event.type === "session.next.retried") {',
    '    return { ...event, type: "session.status", properties: { ...properties, status: { type: "busy" } } };',
    '  }',
    '  return event;',
    '}',
    ''
  ]
}
