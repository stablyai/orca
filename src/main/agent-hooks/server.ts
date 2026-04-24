/* eslint-disable max-lines -- Why: the hook server owns the full HTTP ingest surface (routing, body parsing, per-CLI normalization, transcript scan, pane dispatch) in one place so the contract with Claude/Codex/Gemini hooks stays consistent and doesn't drift across files. */
import { createServer, type IncomingMessage, type ServerResponse } from 'http'
import { randomUUID } from 'crypto'
import { closeSync, openSync, readSync, statSync } from 'fs'
import {
  parseAgentStatusPayload,
  type ParsedAgentStatusPayload
} from '../../shared/agent-status-types'
import { ORCA_HOOK_PROTOCOL_VERSION } from '../../shared/agent-hook-types'

// Why: Pi is intentionally absent. Pi has no shell-command hook surface —
// its extensibility is an in-process TypeScript extension API (pi.on(...)
// with events like turn_start/turn_end/tool_execution_start), not a
// settings.json hook block that we could install alongside the Claude/Codex/
// Gemini ones. Wiring Pi would require shipping a bundled Pi extension
// that POSTs to this server; until we do that, Pi panes fall back to
// terminal-title heuristics like any uninstrumented CLI.
//
// OpenCode rides this server via a bundled plugin (see opencode/hook-service)
// that fetch()es /hook/opencode from inside the OpenCode process. Unlike
// Claude/Codex/Gemini, OpenCode's event names are in-process plugin events
// (session.status, session.idle, permission.asked) rather than settings.json
// hook names, so the plugin pre-maps them to our hook_event_name vocabulary
// before POSTing. See normalizeOpenCodeEvent below for the mapping.
type AgentHookSource = 'claude' | 'codex' | 'gemini' | 'opencode'

type AgentHookEventPayload = {
  paneKey: string
  tabId?: string
  worktreeId?: string
  payload: ParsedAgentStatusPayload
}

// Why: only log a given version/env mismatch once per process so a stale hook
// script that fires on every keystroke doesn't flood the logs.
const warnedVersions = new Set<string>()
const warnedEnvs = new Set<string>()
// Why: cap the warning Sets so a buggy or malicious local client that varies
// its `version`/`env` fields per request cannot grow these Sets without bound
// for the process lifetime. Once saturated, we drop further warnings (and skip
// inserting the new key) — the diagnostic value of "warn once" is preserved
// for the common case while memory stays bounded against untrusted input.
const MAX_WARNED_KEYS = 32

// Why: Claude documents `prompt` on UserPromptSubmit; other agents may use
// different field names. Probe a small allowlist so we can surface the real
// user prompt in the dashboard regardless of which agent is reporting.
function extractPromptText(hookPayload: Record<string, unknown>): string {
  const candidateKeys = ['prompt', 'user_prompt', 'userPrompt', 'message']
  for (const key of candidateKeys) {
    const value = hookPayload[key]
    if (typeof value === 'string' && value.trim().length > 0) {
      return value
    }
  }
  // Why: OpenCode's plugin sends MessagePart events with { role, text }. When
  // role === 'user', the text *is* the prompt — surface it so the dashboard
  // shows the user's most recent input even though OpenCode has no dedicated
  // UserPromptSubmit event we can hook into.
  if (hookPayload.role === 'user' && typeof hookPayload.text === 'string') {
    const trimmed = hookPayload.text.trim()
    if (trimmed.length > 0) {
      return hookPayload.text
    }
  }
  return ''
}

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let byteLength = 0
    let settled = false
    req.on('data', (chunk: Buffer) => {
      if (settled) {
        return
      }
      // Why: check size in bytes (not UTF-16 code units) and stop accumulating
      // after rejection so a malicious client cannot push memory past the
      // advertised 1 MB cap.
      if (byteLength + chunk.length > 1_000_000) {
        settled = true
        reject(new Error('payload too large'))
        req.destroy()
        return
      }
      byteLength += chunk.length
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (settled) {
        return
      }
      settled = true
      try {
        // Why: decode once via Buffer.concat so multi-byte UTF-8 characters that
        // straddle a chunk boundary are reassembled correctly. Per-chunk
        // `.toString('utf8')` would corrupt emoji or non-ASCII inside assistant
        // messages.
        const body = chunks.length > 0 ? Buffer.concat(chunks).toString('utf8') : ''
        resolve(body ? JSON.parse(body) : {})
      } catch (error) {
        reject(error)
      }
    })
    req.on('error', (err) => {
      if (settled) {
        return
      }
      settled = true
      reject(err)
    })
  })
}

// Why: only UserPromptSubmit carries the user's prompt. Subsequent events in
// the same turn (PostToolUse, PermissionRequest, Stop, …) arrive with no
// prompt, so we cache the last prompt per pane and reuse it until a new
// prompt arrives. The cache survives across `done` so the user can still see
// what finished; it's reset on the next UserPromptSubmit.
const lastPromptByPaneKey = new Map<string, string>()

function resolvePrompt(paneKey: string, promptText: string): string {
  if (promptText) {
    lastPromptByPaneKey.set(paneKey, promptText)
    return promptText
  }
  return lastPromptByPaneKey.get(paneKey) ?? ''
}

type ToolSnapshot = {
  toolName?: string
  toolInput?: string
  lastAssistantMessage?: string
}

// Why: mirrors `lastPromptByPaneKey`. Tool + assistant metadata arrives
// piecemeal (PreToolUse gives name+input; PostToolUse gives response;
// Stop gives the final message), and later events typically omit fields
// the earlier ones provided. Caching per-pane lets the renderer show a
// coherent snapshot instead of blinking whenever a field is missing.
const lastToolByPaneKey = new Map<string, ToolSnapshot>()

function resolveToolState(
  paneKey: string,
  update: ToolSnapshot,
  options: { resetOnNewTurn: boolean }
): ToolSnapshot {
  if (options.resetOnNewTurn) {
    // Why: a fresh user turn shouldn't inherit the previous turn's
    // tool/assistant state — it would look like the agent is still on
    // the old step until the first new tool event lands.
    lastToolByPaneKey.delete(paneKey)
  }
  const previous = lastToolByPaneKey.get(paneKey) ?? {}
  const merged: ToolSnapshot = {
    toolName: update.toolName ?? previous.toolName,
    toolInput: update.toolInput ?? previous.toolInput,
    lastAssistantMessage: update.lastAssistantMessage ?? previous.lastAssistantMessage
  }
  lastToolByPaneKey.set(paneKey, merged)
  return merged
}

// Why: per-tool allowlist (noqa style) — explicit mapping from tool name to
// the single input field worth surfacing. Tools that aren't listed render
// name-only. This avoids noisy fallbacks (e.g. "TaskUpdate 3" from the
// task_id field) and keeps the preview honest: if we don't know how to
// describe a tool's input meaningfully, we show nothing rather than guess.
//
// Ordering matters when a tool sends multiple well-known keys (e.g. Grep
// sends both `pattern` and `path`); the first match wins.
const TOOL_INPUT_KEYS_BY_TOOL: Record<string, readonly string[]> = {
  // Claude tools (PascalCase).
  Read: ['file_path', 'filePath', 'path'],
  Write: ['file_path', 'filePath', 'path'],
  Edit: ['file_path', 'filePath', 'path'],
  MultiEdit: ['file_path', 'filePath', 'path'],
  NotebookEdit: ['file_path', 'filePath', 'path'],
  Bash: ['command'],
  Glob: ['pattern'],
  Grep: ['pattern'],
  WebFetch: ['url'],
  WebSearch: ['query'],
  // Gemini tools (snake_case).
  read_file: ['file_path', 'path'],
  write_file: ['file_path', 'path'],
  read_many_files: ['file_path', 'paths', 'path'],
  edit_file: ['file_path', 'path'],
  replace: ['file_path', 'path'],
  run_shell_command: ['command'],
  glob: ['pattern'],
  search_file_content: ['pattern'],
  web_fetch: ['url'],
  google_web_search: ['query'],
  // Codex tools. `exec_command` and `shell_command` both carry their command
  // text under `cmd` (the Rust payload) or `command` (some wrappers); list
  // both so whichever field is populated wins. `apply_patch` surfaces the
  // touched path. `view_image` is path-only. `write_stdin` gets nothing
  // meaningful — intentionally omitted so the row stays name-only.
  exec_command: ['cmd', 'command'],
  shell_command: ['cmd', 'command'],
  apply_patch: ['path', 'file_path'],
  view_image: ['path', 'file_path']
}

function deriveToolInputPreview(
  toolName: string | undefined,
  toolInput: unknown
): string | undefined {
  if (typeof toolInput === 'string') {
    return toolInput
  }
  if (typeof toolInput !== 'object' || toolInput === null) {
    return undefined
  }
  if (!toolName) {
    return undefined
  }
  const keys = TOOL_INPUT_KEYS_BY_TOOL[toolName]
  if (!keys) {
    return undefined
  }
  const record = toolInput as Record<string, unknown>
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.trim().length > 0) {
      return value
    }
  }
  return undefined
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

// Why: Claude `tool_response` can be a string, or an object with a `content`
// array shaped like `[{type: 'text', text: '...'}]`. Surface the first text
// block so PostToolUse for Task/Agent subagents carries something useful into
// the `lastAssistantMessage` slot.
function extractToolResponseText(toolResponse: unknown): string | undefined {
  if (typeof toolResponse === 'string' && toolResponse.length > 0) {
    return toolResponse
  }
  if (typeof toolResponse !== 'object' || toolResponse === null) {
    return undefined
  }
  const record = toolResponse as Record<string, unknown>
  const content = record.content
  if (Array.isArray(content)) {
    for (const part of content) {
      if (typeof part === 'object' && part !== null) {
        const text = (part as Record<string, unknown>).text
        if (typeof text === 'string' && text.trim().length > 0) {
          return text
        }
      }
    }
  }
  const text = record.text
  if (typeof text === 'string' && text.trim().length > 0) {
    return text
  }
  return undefined
}

// Why: Claude's Stop event carries `transcript_path` to a JSONL transcript.
// Reading the last assistant message gives us the "what did the agent just
// say" preview without needing to buffer tool_response text across PostToolUse
// events. We scan backward from the end of the file in chunks, stopping as
// soon as we find an assistant text entry — bounded work in the common case
// (one chunk) even when transcripts grow to hundreds of MB.
const TRANSCRIPT_CHUNK_BYTES = 64 * 1024
// Why: ultimate safety cap so a malformed transcript (or a turn with
// pathologically many tool calls and no assistant text) cannot stall the Stop
// handler. 4 MB easily accommodates dozens of tool rounds before the final
// reply; past that, we give up rather than block the hook response.
const TRANSCRIPT_MAX_SCAN_BYTES = 4 * 1024 * 1024

function extractAssistantTextFromLine(line: string): string | undefined {
  let entry: unknown
  try {
    entry = JSON.parse(line)
  } catch {
    return undefined
  }
  if (typeof entry !== 'object' || entry === null) {
    return undefined
  }
  const record = entry as Record<string, unknown>
  const nestedMessage = record.message as Record<string, unknown> | undefined
  const role = record.role ?? nestedMessage?.role
  if (role !== 'assistant') {
    return undefined
  }
  const content = (nestedMessage ?? record).content
  if (typeof content === 'string' && content.trim().length > 0) {
    return content
  }
  // Why: assistant entries can be pure tool_use turns with no text parts.
  // Return undefined so the caller keeps scanning backward for the most
  // recent entry that actually contains assistant text.
  if (Array.isArray(content)) {
    for (const part of content) {
      if (typeof part === 'object' && part !== null) {
        const text = (part as Record<string, unknown>).text
        if (typeof text === 'string' && text.trim().length > 0) {
          return text
        }
      }
    }
  }
  return undefined
}

function readLastAssistantFromTranscript(transcriptPath: unknown): string | undefined {
  if (typeof transcriptPath !== 'string' || transcriptPath.length === 0) {
    return undefined
  }
  try {
    const stats = statSync(transcriptPath)
    const size = stats.size
    if (size <= 0) {
      return undefined
    }
    const fd = openSync(transcriptPath, 'r')
    try {
      // Why: track unhandled trailing bytes as raw Buffer across iterations so
      // multi-byte UTF-8 codepoints that straddle chunk boundaries are not
      // corrupted. `carryBytes` holds bytes from the earliest partial line we
      // saw; when the next (earlier) chunk arrives we concat and decode once.
      let carryBytes: Buffer = Buffer.alloc(0)
      let bytesRead = 0
      while (bytesRead < size && bytesRead < TRANSCRIPT_MAX_SCAN_BYTES) {
        const chunkSize = Math.min(size - bytesRead, TRANSCRIPT_CHUNK_BYTES)
        const position = size - bytesRead - chunkSize
        const buffer = Buffer.alloc(chunkSize)
        // Why: readSync may return fewer bytes than requested (short reads);
        // only the first `n` bytes are valid — decoding the unused tail would
        // produce NUL bytes that break JSON.parse.
        const n = readSync(fd, buffer, 0, chunkSize, position)
        bytesRead += n
        if (n === 0) {
          break
        }
        const combined = Buffer.concat([buffer.subarray(0, n), carryBytes])
        const text = combined.toString('utf8')
        const lines = text.split('\n')
        // Why: unless we've reached the very start of the file, the first line
        // is still potentially partial — carry it forward for the next chunk
        // to complete. At start-of-file every line is complete, so scan all.
        const atStart = bytesRead >= size
        const startIdx = atStart ? 0 : 1
        for (let i = lines.length - 1; i >= startIdx; i--) {
          const line = lines[i].trim()
          if (line.length === 0) {
            continue
          }
          const extracted = extractAssistantTextFromLine(line)
          if (extracted !== undefined) {
            return extracted
          }
        }
        carryBytes = atStart ? Buffer.alloc(0) : Buffer.from(lines[0], 'utf8')
      }
      return undefined
    } finally {
      closeSync(fd)
    }
  } catch {
    return undefined
  }
}

function extractClaudeToolFields(
  eventName: unknown,
  hookPayload: Record<string, unknown>
): ToolSnapshot {
  const update: ToolSnapshot = {}
  if (
    eventName === 'PreToolUse' ||
    eventName === 'PostToolUse' ||
    eventName === 'PostToolUseFailure'
  ) {
    const toolName = readString(hookPayload, 'tool_name')
    update.toolName = toolName
    update.toolInput = deriveToolInputPreview(toolName, hookPayload.tool_input)
  }
  if (eventName === 'PostToolUse') {
    const responseText = extractToolResponseText(hookPayload.tool_response)
    if (responseText) {
      update.lastAssistantMessage = responseText
    }
  }
  if (eventName === 'PostToolUseFailure') {
    const errorText =
      extractToolResponseText(hookPayload.tool_response) ??
      readString(hookPayload, 'error') ??
      readString(hookPayload, 'message')
    if (errorText) {
      update.lastAssistantMessage = errorText
    }
  }
  if (eventName === 'Stop') {
    // Why: newer Claude versions include `last_assistant_message` directly on
    // the Stop payload, which is both cheaper and more reliable than reading
    // the JSONL transcript. Prefer it when present; fall back to transcript
    // scanning for older Claude versions that omit the field.
    const direct = readString(hookPayload, 'last_assistant_message')
    if (direct) {
      update.lastAssistantMessage = direct
    } else {
      const lastFromTranscript = readLastAssistantFromTranscript(hookPayload.transcript_path)
      if (lastFromTranscript) {
        update.lastAssistantMessage = lastFromTranscript
      }
    }
  }
  return update
}

function extractCodexToolFields(
  eventName: unknown,
  hookPayload: Record<string, unknown>
): ToolSnapshot {
  if (eventName === 'PreToolUse' || eventName === 'PostToolUse') {
    // Why: Codex emits tool metadata under `tool_name` + `tool_input`
    // (matching Claude's shape). We surface both so the dashboard row can
    // show what the agent is currently doing during the otherwise-silent
    // gap between UserPromptSubmit and Stop. See TOOL_INPUT_KEYS_BY_TOOL
    // for which input field is previewed per Codex tool name.
    const toolName = readString(hookPayload, 'tool_name') ?? readString(hookPayload, 'name')
    const toolInput =
      deriveToolInputPreview(toolName, hookPayload.tool_input) ??
      deriveToolInputPreview(toolName, hookPayload.input) ??
      deriveToolInputPreview(toolName, hookPayload.arguments)
    return { toolName, toolInput }
  }
  if (eventName === 'Stop') {
    // Why: Codex documents `last_assistant_message` on Stop.
    const message = readString(hookPayload, 'last_assistant_message')
    if (message) {
      return { lastAssistantMessage: message }
    }
  }
  return {}
}

function extractGeminiToolFields(
  eventName: unknown,
  hookPayload: Record<string, unknown>
): ToolSnapshot {
  if (eventName === 'PreToolUse' || eventName === 'PostToolUse' || eventName === 'AfterTool') {
    const toolName = readString(hookPayload, 'tool_name') ?? readString(hookPayload, 'name')
    const toolInput =
      deriveToolInputPreview(toolName, hookPayload.tool_input) ??
      deriveToolInputPreview(toolName, hookPayload.args) ??
      deriveToolInputPreview(toolName, hookPayload.input)
    return { toolName, toolInput }
  }
  if (eventName === 'AfterAgent') {
    // Why: Gemini's AfterAgent payload carries the final reply under
    // `prompt_response` (per geminicli.com/docs/hooks/reference). This is
    // Gemini's analogue of Claude/Codex's `last_assistant_message` on Stop;
    // surfacing it lets the dashboard show the agent's response on done.
    const message = readString(hookPayload, 'prompt_response')
    if (message) {
      return { lastAssistantMessage: message }
    }
  }
  return {}
}

function extractOpenCodeToolFields(
  eventName: unknown,
  hookPayload: Record<string, unknown>
): ToolSnapshot {
  if (eventName === 'MessagePart' && hookPayload.role === 'assistant') {
    // Why: OpenCode streams the assistant's reply via repeated MessagePart
    // events (one per text delta flush). Each event carries the cumulative
    // text-so-far for that TextPart, so the latest one we see is the most
    // complete snapshot to surface on `done`. We do NOT gate on SessionIdle
    // because the plugin emits parts *before* session.idle fires, and gating
    // would lose them.
    const text = readString(hookPayload, 'text')
    if (text) {
      return { lastAssistantMessage: text }
    }
  }
  return {}
}

function isNewTurnEvent(source: AgentHookSource, eventName: unknown): boolean {
  if (source === 'claude') {
    return eventName === 'UserPromptSubmit'
  }
  if (source === 'codex') {
    // Why: Codex fires SessionStart at resume AND startup. Both mark the
    // boundary of a fresh interactive turn from the hook's perspective, so
    // clear the tool cache on either one.
    return eventName === 'SessionStart' || eventName === 'UserPromptSubmit'
  }
  if (source === 'gemini') {
    return eventName === 'BeforeAgent'
  }
  // Why: OpenCode's plugin emits SessionBusy when the session transitions
  // idle→busy (i.e. a new turn is starting). That's the only boundary the
  // plugin observes; there's no separate UserPromptSubmit analogue.
  return eventName === 'SessionBusy'
}

function extractToolFields(
  source: AgentHookSource,
  eventName: unknown,
  hookPayload: Record<string, unknown>
): ToolSnapshot {
  if (source === 'claude') {
    return extractClaudeToolFields(eventName, hookPayload)
  }
  if (source === 'codex') {
    return extractCodexToolFields(eventName, hookPayload)
  }
  if (source === 'gemini') {
    return extractGeminiToolFields(eventName, hookPayload)
  }
  return extractOpenCodeToolFields(eventName, hookPayload)
}

function normalizeClaudeEvent(
  eventName: unknown,
  promptText: string,
  paneKey: string,
  hookPayload: Record<string, unknown>
): ParsedAgentStatusPayload | null {
  const state =
    eventName === 'UserPromptSubmit' ||
    eventName === 'PreToolUse' ||
    eventName === 'PostToolUse' ||
    eventName === 'PostToolUseFailure'
      ? 'working'
      : eventName === 'PermissionRequest'
        ? 'waiting'
        : eventName === 'Stop'
          ? 'done'
          : null

  if (!state) {
    return null
  }

  const snapshot = resolveToolState(paneKey, extractToolFields('claude', eventName, hookPayload), {
    resetOnNewTurn: isNewTurnEvent('claude', eventName)
  })

  // Why: Claude Code's `Stop` hook sets `is_interrupt: true` when the turn
  // ended because the user hit ESC / Ctrl+C rather than completing normally.
  // This is the authoritative signal (the agent itself reports it), so we
  // forward it through only on Stop — other hook events don't carry it.
  const interrupted =
    eventName === 'Stop' && hookPayload['is_interrupt'] === true ? true : undefined

  return parseAgentStatusPayload(
    JSON.stringify({
      state,
      prompt: resolvePrompt(paneKey, promptText),
      agentType: 'claude',
      toolName: snapshot.toolName,
      toolInput: snapshot.toolInput,
      lastAssistantMessage: snapshot.lastAssistantMessage,
      interrupted
    })
  )
}

// Why: Gemini CLI exposes BeforeAgent/AfterAgent/AfterTool hooks. BeforeAgent
// fires at turn start and AfterTool resumes the working state after a tool
// call completes; AfterAgent fires when the agent becomes idle. Gemini has no
// permission-prompt hook, so we cannot surface a waiting state for Gemini.
function normalizeGeminiEvent(
  eventName: unknown,
  promptText: string,
  paneKey: string,
  hookPayload: Record<string, unknown>
): ParsedAgentStatusPayload | null {
  const state =
    eventName === 'BeforeAgent' ||
    eventName === 'AfterTool' ||
    eventName === 'PreToolUse' ||
    eventName === 'PostToolUse'
      ? 'working'
      : eventName === 'AfterAgent'
        ? 'done'
        : null

  if (!state) {
    return null
  }

  const snapshot = resolveToolState(paneKey, extractToolFields('gemini', eventName, hookPayload), {
    resetOnNewTurn: isNewTurnEvent('gemini', eventName)
  })

  return parseAgentStatusPayload(
    JSON.stringify({
      state,
      prompt: resolvePrompt(paneKey, promptText),
      agentType: 'gemini',
      toolName: snapshot.toolName,
      toolInput: snapshot.toolInput,
      lastAssistantMessage: snapshot.lastAssistantMessage
    })
  )
}

// Why: we deliberately do NOT map Codex `PreToolUse` to `waiting`. That event
// fires for every tool call, not just ones that actually need approval, so
// mapping it would flicker the dashboard. Instead we keep it at `working`
// (same as Claude) and use it only to update tool-name / tool-input previews
// so a running Codex turn has visible progress between UserPromptSubmit and
// Stop. Real approval signals travel through Codex's separate `notify`
// callback (different install surface); wiring that up is deferred.
function normalizeCodexEvent(
  eventName: unknown,
  promptText: string,
  paneKey: string,
  hookPayload: Record<string, unknown>
): ParsedAgentStatusPayload | null {
  const state =
    eventName === 'SessionStart' ||
    eventName === 'UserPromptSubmit' ||
    eventName === 'PreToolUse' ||
    eventName === 'PostToolUse'
      ? 'working'
      : eventName === 'Stop'
        ? 'done'
        : null

  if (!state) {
    return null
  }

  const snapshot = resolveToolState(paneKey, extractToolFields('codex', eventName, hookPayload), {
    resetOnNewTurn: isNewTurnEvent('codex', eventName)
  })

  return parseAgentStatusPayload(
    JSON.stringify({
      state,
      prompt: resolvePrompt(paneKey, promptText),
      agentType: 'codex',
      toolName: snapshot.toolName,
      toolInput: snapshot.toolInput,
      lastAssistantMessage: snapshot.lastAssistantMessage
    })
  )
}

// Why: OpenCode has no declarative hook surface — it exposes in-process plugin
// events (session.status busy/idle, session.idle, permission.asked,
// message.updated, message.part.updated). The bundled plugin (see
// opencode/hook-service) pre-maps those to our stable hook_event_name
// vocabulary before POSTing so this normalizer can share the same switch
// shape as Claude/Codex/Gemini. SessionBusy = turn started, SessionIdle =
// turn finished, PermissionRequest = blocked on user approval, MessagePart =
// incremental text from user prompt or assistant reply (stays in `working`
// because streaming chunks must not flip the row to done mid-turn).
function normalizeOpenCodeEvent(
  eventName: unknown,
  promptText: string,
  paneKey: string,
  hookPayload: Record<string, unknown>
): ParsedAgentStatusPayload | null {
  const state =
    eventName === 'SessionBusy' || eventName === 'MessagePart'
      ? 'working'
      : eventName === 'SessionIdle'
        ? 'done'
        : eventName === 'PermissionRequest'
          ? 'waiting'
          : null

  if (!state) {
    return null
  }

  const snapshot = resolveToolState(
    paneKey,
    extractToolFields('opencode', eventName, hookPayload),
    { resetOnNewTurn: isNewTurnEvent('opencode', eventName) }
  )

  return parseAgentStatusPayload(
    JSON.stringify({
      state,
      prompt: resolvePrompt(paneKey, promptText),
      agentType: 'opencode',
      toolName: snapshot.toolName,
      toolInput: snapshot.toolInput,
      lastAssistantMessage: snapshot.lastAssistantMessage
    })
  )
}

function readStringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  if (typeof value !== 'string') {
    return undefined
  }
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function normalizeHookPayload(
  source: AgentHookSource,
  body: unknown,
  expectedEnv: string
): AgentHookEventPayload | null {
  if (typeof body !== 'object' || body === null) {
    return null
  }

  const record = body as Record<string, unknown>
  const paneKey = typeof record.paneKey === 'string' ? record.paneKey.trim() : ''
  const hookPayload = record.payload
  if (!paneKey || typeof hookPayload !== 'object' || hookPayload === null) {
    return null
  }

  // Why: scripts installed by an older app build may send a different shape.
  // We accept the request (fail-open) but log once so stale installs are
  // diagnosable instead of silently degrading.
  const version = readStringField(record, 'version')
  if (
    version &&
    version !== ORCA_HOOK_PROTOCOL_VERSION &&
    !warnedVersions.has(version) &&
    warnedVersions.size < MAX_WARNED_KEYS
  ) {
    warnedVersions.add(version)
    console.warn(
      `[agent-hooks] received hook v${version}; server expects v${ORCA_HOOK_PROTOCOL_VERSION}. ` +
        'Reinstall agent hooks from Settings to upgrade the managed script.'
    )
  }

  // Why: detects dev-vs-prod cross-talk. A hook installed by a dev build but
  // triggered inside a prod terminal (or vice versa) still points at whichever
  // loopback port the shell env captured, so the *other* instance may receive
  // it. Logging the mismatch lets a user know their terminals are wired to the
  // wrong Orca.
  const clientEnv = readStringField(record, 'env')
  if (clientEnv && clientEnv !== expectedEnv) {
    const key = `${clientEnv}->${expectedEnv}`
    if (!warnedEnvs.has(key) && warnedEnvs.size < MAX_WARNED_KEYS) {
      warnedEnvs.add(key)
      console.warn(
        `[agent-hooks] received ${clientEnv} hook on ${expectedEnv} server. ` +
          'Likely a stale terminal from another Orca install.'
      )
    }
  }

  const tabId = readStringField(record, 'tabId')
  const worktreeId = readStringField(record, 'worktreeId')

  const eventName = (hookPayload as Record<string, unknown>).hook_event_name
  const promptText = extractPromptText(hookPayload as Record<string, unknown>)
  const hookPayloadRecord = hookPayload as Record<string, unknown>
  const payload =
    source === 'claude'
      ? normalizeClaudeEvent(eventName, promptText, paneKey, hookPayloadRecord)
      : source === 'codex'
        ? normalizeCodexEvent(eventName, promptText, paneKey, hookPayloadRecord)
        : source === 'gemini'
          ? normalizeGeminiEvent(eventName, promptText, paneKey, hookPayloadRecord)
          : normalizeOpenCodeEvent(eventName, promptText, paneKey, hookPayloadRecord)

  return payload ? { paneKey, tabId, worktreeId, payload } : null
}

export class AgentHookServer {
  private server: ReturnType<typeof createServer> | null = null
  private port = 0
  private token = ''
  // Why: identifies this Orca instance so hook scripts can stamp requests and
  // the server can detect dev vs. prod cross-talk. Set at start() from the
  // caller's knowledge of whether this is a packaged build.
  private env = 'production'
  private onAgentStatus: ((payload: AgentHookEventPayload) => void) | null = null

  setListener(listener: ((payload: AgentHookEventPayload) => void) | null): void {
    this.onAgentStatus = listener
  }

  async start(options?: { env?: string }): Promise<void> {
    if (this.server) {
      return
    }

    if (options?.env) {
      this.env = options.env
    }
    this.token = randomUUID()
    this.server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      if (req.method !== 'POST') {
        res.writeHead(404)
        res.end()
        return
      }

      if (req.headers['x-orca-agent-hook-token'] !== this.token) {
        res.writeHead(403)
        res.end()
        return
      }

      // Why: bound request time so a slow/stalled client cannot hold a socket
      // open indefinitely (slowloris-style). The hook endpoints are local and
      // should complete in well under a second.
      req.setTimeout(5000, () => {
        req.destroy()
      })

      try {
        const body = await readJsonBody(req)
        // Why: match on pathname only so a future debugging addition of a
        // query string or trailing slash from a hook sender does not silently
        // 404 a valid, token-authenticated request.
        const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname
        const source: AgentHookSource | null =
          pathname === '/hook/claude'
            ? 'claude'
            : pathname === '/hook/codex'
              ? 'codex'
              : pathname === '/hook/gemini'
                ? 'gemini'
                : pathname === '/hook/opencode'
                  ? 'opencode'
                  : null
        if (!source) {
          res.writeHead(404)
          res.end()
          return
        }

        const payload = normalizeHookPayload(source, body, this.env)
        if (payload) {
          this.onAgentStatus?.(payload)
        }

        res.writeHead(204)
        res.end()
      } catch {
        // Why: agent hooks must fail open. The receiver returns success for
        // malformed payloads so a newer or broken hook never blocks the agent.
        res.writeHead(204)
        res.end()
      }
    })

    await new Promise<void>((resolve, reject) => {
      // Why: the startup error handler must only reject the start() promise for
      // errors that happen before 'listening'. Without swapping it out on
      // success, any later runtime error (e.g. EADDRINUSE during rebind,
      // socket errors) would call reject() on an already-settled promise and,
      // more importantly, leaving it as the only 'error' listener means node
      // treats runtime errors as unhandled and crashes the main process.
      const onStartupError = (err: Error): void => {
        this.server?.off('listening', onListening)
        reject(err)
      }
      const onListening = (): void => {
        this.server?.off('error', onStartupError)
        this.server?.on('error', (err) => {
          console.error('[agent-hooks] server error', err)
        })
        const address = this.server!.address()
        if (address && typeof address === 'object') {
          this.port = address.port
        }
        resolve()
      }
      this.server!.once('error', onStartupError)
      this.server!.listen(0, '127.0.0.1', onListening)
    })
  }

  stop(): void {
    this.server?.close()
    this.server = null
    this.port = 0
    this.token = ''
    this.env = 'production'
    this.onAgentStatus = null
  }

  buildPtyEnv(): Record<string, string> {
    if (this.port <= 0 || !this.token) {
      return {}
    }

    return {
      ORCA_AGENT_HOOK_PORT: String(this.port),
      ORCA_AGENT_HOOK_TOKEN: this.token,
      ORCA_AGENT_HOOK_ENV: this.env,
      ORCA_AGENT_HOOK_VERSION: ORCA_HOOK_PROTOCOL_VERSION
    }
  }
}

export const agentHookServer = new AgentHookServer()

// Why: exported for test coverage of the per-agent field extractors. The
// `normalizeHookPayload` function wraps these with the cache + routing logic
// the tests need to exercise end-to-end; making it test-visible avoids
// having to spin up a real HTTP server just to assert field shaping.
export const _internals = {
  normalizeHookPayload,
  resetCachesForTests: (): void => {
    lastPromptByPaneKey.clear()
    lastToolByPaneKey.clear()
  }
}
