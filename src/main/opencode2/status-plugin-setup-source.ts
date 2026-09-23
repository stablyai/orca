export function getOpenCode2SetupSource(): string[] {
  return String.raw`
const admittedQuestionFormIDs = new Set();

// Why: a long session can raise unboundedly many forms; only the unresolved tail
// can still need retiring, so evict oldest-first rather than retaining them all.
function admitQuestionForm(formID) {
  if (admittedQuestionFormIDs.size >= 64) {
    admittedQuestionFormIDs.delete(admittedQuestionFormIDs.values().next().value);
  }
  admittedQuestionFormIDs.add(formID);
}

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
        // Why: OpenCode 2 raises the same form for its own pickers and for MCP
        // elicitations; only its question tool stamps kind "question", and only
        // that form is a question the pane owner was actually asked.
        if (!form || !form.metadata || form.metadata.kind !== "question") continue;
        admitQuestionForm(form.id);
        type = "question.asked";
        properties = {
          ...form,
          questions: form.fields.map((field) => ({
            header: field.title || form.title,
            question: field.description || field.title || form.title,
            options: (field.options || []).map((option) => ({ label: option.label || option.value, description: option.description || "" })),
            multiple: field.type === "multiselect",
          })),
        };
      } else if (type === "form.replied" || type === "form.cancelled") {
        // Why: a resolution for a form Orca never admitted shares the attention
        // key shape, so forwarding it would retire an unrelated live blocker.
        if (!admittedQuestionFormIDs.delete(properties.id)) continue;
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
