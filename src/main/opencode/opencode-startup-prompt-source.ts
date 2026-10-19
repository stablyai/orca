import { OPENCODE_NATIVE_PROMPT_VERSIONS } from '../../shared/opencode-cli-version'
import { cancelUnreadResponseBody } from '../lib/unread-response-body'
import { parseAgentHookEndpointFile } from '../../shared/agent-hook-endpoint-file'
import {
  OPENCODE_STARTUP_PROMPT_SHA256_ENV,
  OPENCODE_STARTUP_PROMPT_NONCE_ENV,
  OPENCODE_STARTUP_PROMPT_ENDPOINT_ENV,
  OPENCODE_STARTUP_PROMPT_CLAIM_PATH,
  OPENCODE_STARTUP_PROMPT_BODY_ENV
} from '../../shared/opencode-startup-prompt'

export function getOpenCodeStartupPromptSource(): string {
  return String.raw`
const parseEndpoint = ${parseAgentHookEndpointFile.toString()};
const cancelUnreadResponseBody = ${cancelUnreadResponseBody.toString()};
async function claimStartupPrompt(nonce, digest, endpoint, requestId) {
  let response;
  try {
    const { readFile, stat } = await import("node:fs/promises");
    if ((await stat(endpoint)).size > 4096) return false;
    const coords = parseEndpoint(await readFile(endpoint, "utf8"));
    const port = Number(coords.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return false;
    response = await fetch("http://127.0.0.1:" + port + "${OPENCODE_STARTUP_PROMPT_CLAIM_PATH}", {
      method: "POST", headers: { "content-type": "application/json", "x-orca-agent-hook-token": coords.token },
      body: JSON.stringify({ nonce, digest, requestId }), signal: AbortSignal.timeout(1000)
    });
    if (!response.ok) return response.status === 408 || response.status === 429 || response.status >= 500 ? "pending" : false;
    const result = await response.json();
    return result.allowed === true ? true : result.pending === true ? "pending" : false;
  } catch {
    // A lost grant response can be replayed with the same operation ID until expiry.
    return "pending";
  } finally {
    if (response) await cancelUnreadResponseBody(response);
  }
}
async function submitStartupPrompt(ctx) {
  const noop = async () => {};
  const digest = process.env.${OPENCODE_STARTUP_PROMPT_SHA256_ENV};
  const nonce = process.env.${OPENCODE_STARTUP_PROMPT_NONCE_ENV};
  const endpoint = process.env.${OPENCODE_STARTUP_PROMPT_ENDPOINT_ENV};
  const prompt = process.env.${OPENCODE_STARTUP_PROMPT_BODY_ENV};
  if (!${JSON.stringify(OPENCODE_NATIVE_PROMPT_VERSIONS)}.includes(ctx?.app?.version) || !/^[a-f0-9]{64}$/.test(digest || "") || !nonce || !endpoint || !prompt) return noop;
  const input = ctx.renderer?.keyInput;
  if (typeof ctx.storage?.memory !== "function" || typeof input?.on !== "function" ||
      typeof input?.off !== "function" || typeof ctx.keymap?.dispatch !== "function" ||
      typeof ctx.ui?.router?.current !== "function" ||
      typeof ctx.data?.location?.sync !== "function" ||
      typeof ctx.data?.location?.agent?.list !== "function" ||
      typeof ctx.data?.location?.model?.list !== "function") return noop;
  const [memory, setMemory] = ctx.storage.memory("startup-prompt", {
    initial: { settled: false, expiresAt: Date.now() + 20000 }
  });
  if (memory.settled) return noop;
  let timer, editor, seen = false, disposed = false, canceled = false, createHash, requestId, claiming = false, hydrating = false, readyLocation;
  // Home can change location after plugin setup.
  const locationKey = (location) => typeof location?.directory === "string" && location.directory ?
    JSON.stringify([location.directory, location.workspaceID]) : undefined;
  const isComposer = (candidate) => candidate?.traits?.owner === "opencode" &&
    candidate.traits.role === "prompt" && !candidate.traits.status &&
    candidate.traits.capture?.length === 1 && candidate.traits.capture[0] === "tab";
  const matches = (candidate) => typeof candidate?.plainText === "string" &&
    createHash("sha256").update(candidate.plainText).digest("hex") === digest;
  const cleanup = () => {
    clearInterval(timer);
    input.off("keypress", cancel);
    input.off("paste", cancel);
    editor?.off("line-info-change", changed);
  };
  const settle = () => {
    setMemory((draft) => { draft.settled = true; });
    cleanup();
  };
  const cancel = () => { canceled = true; settle(); };
  // Any edit before delivery ends this startup operation.
  const changed = () => { if (seen && editor.plainText !== "") settle(); };
  input.on("keypress", cancel);
  input.on("paste", cancel);
  const dispose = async () => { disposed = true; settle(); };
  try {
    const crypto = await import("node:crypto");
    createHash = crypto.createHash;
    setMemory((draft) => { draft.requestId ??= crypto.randomUUID(); });
    requestId = memory.requestId;
    if (createHash("sha256").update(prompt).digest("hex") !== digest) { await dispose(); return noop; }
    if (memory.settled) return dispose;
    timer = setInterval(async () => {
      if (disposed || memory.settled) return;
      try {
        if (Date.now() >= memory.expiresAt || ctx.ui.router.current()?.type !== "home") return settle();
        const current = ctx.renderer.currentFocusedEditor;
        if (!isComposer(current)) { if (seen) settle(); return; }
        if (editor !== current) {
          if (seen) return settle();
          editor?.off("line-info-change", changed);
          editor = current;
          editor?.on("line-info-change", changed);
        }
        if (typeof editor?.plainText !== "string" || typeof editor?.insertText !== "function") return;
        if (editor.plainText !== "") return settle();
        seen = true;
        const location = ctx.location;
        const key = locationKey(location);
        if (!key) return;
        if (readyLocation !== key) {
          readyLocation = undefined;
          if (!hydrating) {
            hydrating = true;
            const ref = { directory: location.directory, workspaceID: location.workspaceID };
            void ctx.data.location.sync(ref).then(() => {
              hydrating = false;
              if (!disposed && !memory.settled && locationKey(ctx.location) === key) readyLocation = key;
            }, settle);
          }
          return;
        }
        const agents = ctx.data.location.agent.list(location);
        const models = ctx.data.location.model.list(location);
        if (!editor.focused || !agents?.length || !models?.length) return;
        if (claiming) return;
        claiming = true;
        const allowed = await claimStartupPrompt(nonce, digest, endpoint, requestId);
        claiming = false;
        if (allowed === "pending") return;
        if (!allowed) return settle();
        if (disposed || memory.settled || Date.now() >= memory.expiresAt ||
            locationKey(ctx.location) !== key ||
            ctx.ui.router.current()?.type !== "home" || ctx.renderer.currentFocusedEditor !== editor ||
            !editor.focused || !isComposer(editor) || editor.plainText !== "") return settle();
        setMemory((draft) => { draft.settled = true; });
        clearInterval(timer);
        editor.off("line-info-change", changed);
        try {
          editor.insertText(prompt);
          if (disposed || canceled || Date.now() >= memory.expiresAt ||
              locationKey(ctx.location) !== key ||
              ctx.ui.router.current()?.type !== "home" || ctx.renderer.currentFocusedEditor !== editor ||
              !editor.focused || !isComposer(editor) || !matches(editor)) return;
          ctx.keymap.dispatch("prompt.submit");
        } finally { cleanup(); }
      } catch { settle(); }
    }, 100);
    timer.unref?.();
    return dispose;
  } catch {
    settle();
    return noop;
  }
}
export default { id: "orca-opencode-startup-prompt", setup: submitStartupPrompt };
`.trimStart()
}
