import {
  PI_RPC_WORKER_APPEND_SYSTEM_PROMPT,
  PI_RPC_WORKER_SYSTEM_PROMPT
} from './child-environment'
import type { WorkspaceRuntimeDescriptor } from './extension-types'
import { LIFECYCLE_TOOL_NAMES } from './types'
import { buildWorkspaceToolExtensionSource } from './workspace-tool-extension-source'

export type { LifecycleExtension, WorkspaceRuntimeDescriptor } from './extension-types'

export const HANDSHAKE_STATUS_KEY = 'orca.pi.rpc-worker.handshake'
export const ASK_UI_TITLE = 'orca.pi.rpc-worker.ask'
export const SECURE_WORKSPACE_TOOL_NAMES = ['read', 'list', 'write', 'edit'] as const
export const PI_RPC_WORKER_ACTIVE_TOOL_NAMES = [
  ...SECURE_WORKSPACE_TOOL_NAMES,
  ...LIFECYCLE_TOOL_NAMES
] as const

export function buildLifecycleExtensionSource(
  nonce: string,
  workspaceRuntime: WorkspaceRuntimeDescriptor
): string {
  const activeToolNames = JSON.stringify(PI_RPC_WORKER_ACTIVE_TOOL_NAMES)
  return `import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import {
  canonicalWorkspaceRoot,
  listWorkspaceEntries,
  readWorkspaceText
} from ${JSON.stringify(workspaceRuntime.securitySource)};
import {
  editWorkspaceText,
  writeWorkspaceText
} from ${JSON.stringify(workspaceRuntime.mutationSource)};

const SOURCE = import.meta.url;
const ACTIVE_TOOL_NAMES = ${activeToolNames};
const WORKSPACE_RUNTIME = ${JSON.stringify({
    sha256: workspaceRuntime.sourceHash,
    sources: [workspaceRuntime.securitySource, workspaceRuntime.mutationSource]
  })};
const EXPECTED_SYSTEM_PROMPT = ${JSON.stringify(PI_RPC_WORKER_SYSTEM_PROMPT)};
const EXPECTED_APPEND_SYSTEM_PROMPT = ${JSON.stringify(PI_RPC_WORKER_APPEND_SYSTEM_PROMPT)};
const EXPECTED_TOOL_SNIPPETS = {
  read: "Read a bounded UTF-8 file confined to the workspace",
  list: "List bounded entries in a workspace directory",
  write: "Atomically write a bounded UTF-8 workspace file",
  edit: "Atomically edit a bounded UTF-8 workspace file using exact replacements",
  orca_worker_done: "Finish the assigned Orca task exactly once"
};
const EXPECTED_PROMPT_GUIDELINES = [
  "Use read only with relative workspace paths.",
  "Use list only with relative workspace directory paths.",
  "Use write only with relative workspace paths and bounded content.",
  "Use edit with relative workspace paths and unique exact oldText matches.",
  "Call orca_worker_done exactly once as the final action after all work and checks are complete."
];
const strict = { additionalProperties: false } as const;

${buildWorkspaceToolExtensionSource()}
function lifecycleResult(kind: string, payload: unknown, text: string) {
  return {
    content: [{ type: "text" as const, text }],
    details: { protocol: "orca.pi.lifecycle", version: 1, kind, payload }
  };
}

async function attestModelContext(event: {
  systemPrompt: string;
  systemPromptOptions: {
    customPrompt?: string;
    appendSystemPrompt?: string;
    selectedTools?: string[];
    toolSnippets?: Record<string, string>;
    promptGuidelines?: string[];
    cwd: string;
    contextFiles?: unknown[];
    skills?: unknown[];
  };
}, workspaceRoot: string) {
  const options = event.systemPromptOptions;
  const optionRoot = await canonicalWorkspaceRoot(options.cwd);
  const promptCwd = options.cwd.replace(/\\\\/g, "/");
  const expectedPrompt = EXPECTED_SYSTEM_PROMPT + "\\n\\n" +
    EXPECTED_APPEND_SYSTEM_PROMPT + "\\nCurrent working directory: " + promptCwd + "\\n";
  if (
    optionRoot !== workspaceRoot ||
    event.systemPrompt !== expectedPrompt ||
    options.customPrompt !== EXPECTED_SYSTEM_PROMPT ||
    options.appendSystemPrompt !== EXPECTED_APPEND_SYSTEM_PROMPT ||
    JSON.stringify(options.selectedTools) !== JSON.stringify(ACTIVE_TOOL_NAMES) ||
    JSON.stringify(options.toolSnippets) !== JSON.stringify(EXPECTED_TOOL_SNIPPETS) ||
    JSON.stringify(options.promptGuidelines) !== JSON.stringify(EXPECTED_PROMPT_GUIDELINES) ||
    (options.contextFiles?.length ?? 0) !== 0 ||
    (options.skills?.length ?? 0) !== 0
  ) {
    throw new Error("Pi RPC worker model context is not isolated");
  }
}

function attestActiveTools(pi: ExtensionAPI, select: boolean) {
  if (select) pi.setActiveTools(ACTIVE_TOOL_NAMES);
  const active = pi.getActiveTools();
  if (
    active.length !== ACTIVE_TOOL_NAMES.length ||
    active.some((name) => !ACTIVE_TOOL_NAMES.includes(name)) ||
    ACTIVE_TOOL_NAMES.some((name) => !active.includes(name))
  ) {
    throw new Error("Pi RPC worker active tool names are not exact");
  }
  const ownPath = fileURLToPath(SOURCE);
  const selected = new Map(pi.getAllTools().map((tool) => [tool.name, tool]));
  return ACTIVE_TOOL_NAMES.map((name) => {
    const tool = selected.get(name);
    const path = tool?.sourceInfo?.path;
    if (path !== ownPath && path !== SOURCE) {
      throw new Error("Pi RPC worker active tool source is not the selected extension");
    }
    return { name, source: SOURCE };
  });
}

export default function (pi: ExtensionAPI) {
  let doneClaimed = false;
  let workspaceRoot: string | undefined;
  const getWorkspaceRoot = () => {
    if (!workspaceRoot) throw new Error("Secure workspace root is not initialized");
    return workspaceRoot;
  };

  registerWorkspaceTools(pi, getWorkspaceRoot);

  pi.on("session_start", async (_event, ctx) => {
    workspaceRoot = await canonicalWorkspaceRoot(ctx.cwd);
    const tools = attestActiveTools(pi, true);
    ctx.ui.setStatus(${JSON.stringify(HANDSHAKE_STATUS_KEY)}, JSON.stringify({
      protocol: "orca.pi.rpc-worker.handshake",
      version: 1,
      nonce: ${JSON.stringify(nonce)},
      source: SOURCE,
      workspaceRuntime: WORKSPACE_RUNTIME,
      tools
    }));
  });

  pi.on("before_agent_start", async (event) => {
    attestActiveTools(pi, false);
    await attestModelContext(event, getWorkspaceRoot());
  });

  pi.on("tool_call", (event) => {
    attestActiveTools(pi, false);
    if (!ACTIVE_TOOL_NAMES.includes(event.toolName)) {
      return { block: true, reason: "Tool is outside the attested Pi RPC worker surface", terminate: true };
    }
  });

  pi.registerTool({
    name: "orca_worker_done",
    label: "Finish Orca Worker",
    description: "Finish this Orca worker exactly once. The body must be a three-sentence executive summary of work, findings, and remaining work.",
    promptSnippet: "Finish the assigned Orca task exactly once",
    promptGuidelines: ["Call orca_worker_done exactly once as the final action after all work and checks are complete."],
    executionMode: "sequential",
    parameters: Type.Object({
      outcome: Type.String({ enum: ["succeeded", "failed"] }),
      subject: Type.String({ minLength: 1, maxLength: 160 }),
      body: Type.String({ minLength: 1, maxLength: 4096 }),
      filesModified: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 1024 }), { maxItems: 128 })),
      reportPath: Type.Optional(Type.String({ minLength: 1, maxLength: 2048 }))
    }, strict),
    async execute(_id, params, _signal, _update, ctx) {
      if (doneClaimed) throw new Error("orca_worker_done may be called only once");
      doneClaimed = true;
      ctx.shutdown();
      return {
        ...lifecycleResult("worker_done", params, "Orca worker completion recorded; shutting down."),
        terminate: true
      };
    }
  });

  pi.registerTool({
    name: "orca_ask_coordinator",
    label: "Ask Orca Coordinator",
    description: "Ask the coordinator one bounded question and wait for its response.",
    executionMode: "sequential",
    parameters: Type.Object({
      question: Type.String({ minLength: 1, maxLength: 4096 }),
      options: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 256, pattern: "^[^,]*$" }), { maxItems: 20 }))
    }, strict),
    async execute(_id, params, signal, _update, ctx) {
      const answer = params.options?.length
        ? await ctx.ui.select(${JSON.stringify(ASK_UI_TITLE)}, params.options, { signal })
        : await ctx.ui.input(${JSON.stringify(ASK_UI_TITLE)}, "Waiting for coordinator", { signal });
      if (answer === undefined) throw new Error("Coordinator question was not answered");
      return lifecycleResult("ask", params, answer);
    }
  });

  pi.registerTool({
    name: "orca_escalate",
    label: "Escalate to Orca Coordinator",
    description: "Report a bounded blocker to the coordinator without exposing transport metadata.",
    executionMode: "sequential",
    parameters: Type.Object({
      subject: Type.String({ minLength: 1, maxLength: 160 }),
      body: Type.String({ minLength: 1, maxLength: 4096 })
    }, strict),
    async execute(_id, params) {
      return lifecycleResult("escalation", params, "Escalation reported to the coordinator.");
    }
  });

  pi.registerTool({
    name: "orca_report_progress",
    label: "Report Orca Progress",
    description: "Report bounded, redacted progress to the coordinator.",
    executionMode: "sequential",
    parameters: Type.Object({
      phase: Type.String({ enum: ["investigating", "implementing", "reviewing", "waiting"] }),
      message: Type.String({ minLength: 1, maxLength: 2048 })
    }, strict),
    async execute(_id, params) {
      return lifecycleResult("progress", params, "Progress reported to the coordinator.");
    }
  });
}
`
}
