import { getOpenCode2TuiSource } from './status-plugin-tui-source'
import { openCodeTuiPluginDirName } from '../../shared/opencode-tui-plugin-install'
import { getLegacyOpenCodeTuiSource } from '../opencode/status-plugin-legacy-tui-source'

/** The OpenCode 2 entry points (server setup and TUI reporter) plus the constants they share. */
export function getOpenCode2ModuleSource(pluginID: string, expectedAgent: string): string[] {
  return [
    `const ORCA_TUI_PLUGIN_ENTRY = new URL("./${openCodeTuiPluginDirName(`${pluginID}.js`)}/tui.js", import.meta.url);`,
    `const ORCA_STATUS_AGENT = "${expectedAgent}";`,
    ...getLegacyOpenCodeTuiSource(),
    ...getOpenCode2SetupSource()
  ]
}

export function getOpenCode2SetupSource(): string[] {
  return String.raw`
// Why: OpenCode owns a form under a session id, and Orca retires a blocker when
// that session goes idle. An owner that is not a real session has no idle, so a
// blocker minted for it can only ever be retired by an exact reply — add an id
// here to drop forms Orca could otherwise strand. OpenCode's own schema calls
// "global" a temporary MCP-elicitation sentinel it intends to replace with real
// session ids; when it does, this set stops matching and those forms block.
const NON_SESSION_FORM_OWNERS = new Set(["global"]);

// Why one translation: the TUI reporter builds its Needs input payloads with it, so a blocker
// reaches Orca in the same shape whichever process reported it.
function translateOpenCode2Event(inputType, data) {
  let type = inputType;
  let properties = data || {};
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
    if (!form || NON_SESSION_FORM_OWNERS.has(form.sessionID)) return null;
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
  return { type, properties };
}

// Why: every OpenCode 2 server runs as a "serve" process (the shared service or a
// --standalone child) whose env names only the pane that spawned it, so each full TUI
// reports its own pane through the TUI copy of this plugin instead.
async function tuiReportsPaneLifecycle() {
  if (!process.argv.includes("serve")) return false;
  try {
    const { statSync } = await import("node:fs");
    // Why: an installer that predates the TUI copy (e.g. an older SSH relay) writes only
    // this file; without the TUI copy nothing else would report, so keep reporting.
    return statSync(ORCA_TUI_PLUGIN_ENTRY).isFile();
  } catch {
    return false;
  }
}

async function setupOpenCode2Status(ctx) {
  const noop = async () => {};
  if (isOpenCode2TuiContext(ctx)) {
    reportingOpenCodeMajor = 2;
    return setupOpenCode2Tui(ctx);
  }
  let hooks;
  // Why: OpenCode may probe setup() with no context during startup, and the setup
  // API shape can drift between releases. Never throw from setup — a throw surfaces
  // as an 'orca-opencode-status' plugin failed error in the TUI, which is worse
  // than silently running without status reporting.
  try {
    if (!ctx || typeof ctx.session?.hook !== "function" || typeof ctx.event?.subscribe !== "function") return noop;
    reportingOpenCodeMajor = 2;
    if (await tuiReportsPaneLifecycle()) return noop;
    const controller = new AbortController();
    // Why the envelope: OpenCode 2's plugin adapter unwraps a single-property
    // { data } success schema, so ctx.session.get resolves to the bare record —
    // but the shared lineage lookup only accepts result?.data?.id === sessionID.
    // Without it, resolveRootSessionID returns null for every session and a
    // subagent's work publishes as if it were the root's.
    const client = { session: { get: async (input, options) => { const result = await ctx.session.get(input, options); return result && typeof result.id === "string" ? { data: result } : result; } } };
    // Why: this host disposes plugins on a hot reload while turns keep running.
    hooks = await OrcaOpenCodeStatusPlugin({ client, sessionsOutliveDispose: true });
    if (!hooks || typeof hooks.event !== "function") return noop;
    const promptRegistration = await ctx.session.hook("prompt", async (properties) => {
      await hooks.event({ event: { type: "session.next.prompt.admitted", properties } });
    });
    const consume = async () => {
      for await (const input of ctx.event.subscribe({ signal: controller.signal })) {
        if (controller.signal.aborted) break;
        const translated = translateOpenCode2Event(input.type, input.data);
        if (!translated) continue;
        await hooks.event({ event: translated });
      }
    };
    const consuming = consume().catch((error) => {
      if (!controller.signal.aborted) console.warn("[orca-hook] event subscription failed:", error.message);
    });
    return async () => {
      try {
        controller.abort();
        // Each owner must finish cleanup even when an earlier disposer rejects.
        try {
          await promptRegistration?.dispose?.();
        } finally {
          try {
            await consuming;
          } finally {
            await hooks.dispose?.();
          }
        }
      } catch {
        // Why: cleanup runs during plugin unload; a throw here also fails the plugin.
      }
    };
  } catch {
    try { await hooks?.dispose?.(); } catch {}
    return noop;
  }
}
`
    .split('\n')
    .concat(getOpenCode2TuiSource())
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
