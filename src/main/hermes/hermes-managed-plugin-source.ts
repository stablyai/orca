import { createHash } from 'node:crypto'
import {
  ORCA_SCRUB_SAFE_LAUNCH_ENV,
  ORCA_SCRUB_SAFE_PANE_ENV
} from '../../shared/agent-hook-listener/transport/agent-hook-scrub-safe-env'
import { SHARED_TOOL_PROCESS_SESSION_ENV_NAMES } from '../runtime/agent-session/environment/shared-tool-process-session-env'
import {
  ORCA_AGENT_SESSION_TOOL_TOKEN_ENV,
  SHARED_TOOL_PROCESS_SESSION_FILES,
  SHARED_TOOL_PROCESS_SESSION_ID_PATTERN
} from '../../shared/agent-session/lifecycle/launch/agent-session-caller-env'

export const HERMES_PLUGIN_NAME = 'orca-status'
export const HERMES_PLUGIN_MARKER = 'Managed by Orca. Do not edit; changes may be overwritten.'

export const HERMES_EVENTS = [
  'on_session_start',
  'pre_llm_call',
  'post_llm_call',
  'pre_tool_call',
  'post_tool_call',
  'pre_approval_request',
  'post_approval_response',
  'on_session_end',
  'on_session_finalize',
  'on_session_reset'
] as const

// Hermes' shared gateway binds only these client env names to a session; KEY/TOKEN names never travel.
export const HERMES_CLIENT_ENV_PASSTHROUGH: readonly string[] = [
  ORCA_SCRUB_SAFE_PANE_ENV,
  ORCA_SCRUB_SAFE_LAUNCH_ENV,
  'ORCA_TAB_ID',
  'ORCA_WORKTREE_ID',
  'ORCA_AGENT_HOOK_ENDPOINT',
  'ORCA_AGENT_HOOK_ENV',
  'ORCA_AGENT_HOOK_VERSION'
]

/** Where, under the profile's home, Orca writes each chat's tool environment, named
 *  `<session id>.json`: outside the plugin, so removing the plugin never strips a running chat. */
export const HERMES_SESSION_ENV_DIR = SHARED_TOOL_PROCESS_SESSION_FILES[0].dir
/** The Hermes session ids Orca writes and the plugin reads as file names. */
export const HERMES_SESSION_ID_PATTERN = SHARED_TOOL_PROCESS_SESSION_ID_PATTERN

export function getPluginManifest(): string {
  return [
    `# ${HERMES_PLUGIN_MARKER}`,
    `name: ${HERMES_PLUGIN_NAME}`,
    'version: 1.0.0',
    'description: "Reports Hermes Agent lifecycle events to Orca and runs each Orca chat\'s tools as that chat."',
    'author: "Orca"',
    'kind: standalone',
    'provides_hooks:',
    ...HERMES_EVENTS.map((event) => `  - ${event}`),
    ''
  ].join('\n')
}

/** Each process the plugin loads in, with session env registered, writes `<prefix><pid>` here. */
export const HERMES_PLUGIN_LOADED_PREFIX = '.loaded-'
const GENERATION_PLACEHOLDER = '__ORCA_PLUGIN_GENERATION__'

/** This build's plugin, by its source: a gateway marked with another one runs an older plugin. */
export const HERMES_PLUGIN_GENERATION = createHash('sha256')
  .update(pluginInitTemplate())
  .digest('hex')
  .slice(0, 16)

export function getPluginInitSource(): string {
  return pluginInitTemplate().replace(GENERATION_PLACEHOLDER, HERMES_PLUGIN_GENERATION)
}

function pluginInitTemplate(): string {
  return `# ${HERMES_PLUGIN_MARKER}
from __future__ import annotations

import json
import os
import re
import urllib.error
import urllib.request
from typing import Any, Callable, Optional

try:
    from agent.session_client_env import bound_client_env
except ImportError:
    # Hermes before the shared gateway runs each pane's session in that pane's own process.
    bound_client_env = None

try:
    from gateway.session_context import _bound_session_value
except ImportError:
    _bound_session_value = None

EVENTS = ${JSON.stringify(HERMES_EVENTS)}
# Why: the gateway runs every chat's tools, so its own environment names no chat. Orca writes each
# chat's here, by Hermes session id, and Hermes asks for it at every tool spawn.
SESSION_ENV_NAMES = ${JSON.stringify(SHARED_TOOL_PROCESS_SESSION_ENV_NAMES)}
# <home>/plugins/orca-status/__init__.py → <home>/<sessions dir>
SESSION_ENV_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), "${HERMES_SESSION_ENV_DIR}")
LOADED_MARK = os.path.join(SESSION_ENV_DIR, "${HERMES_PLUGIN_LOADED_PREFIX}%d" % os.getpid())
SESSION_ID = re.compile(r"${HERMES_SESSION_ID_PATTERN}")
GENERATION = "${GENERATION_PLACEHOLDER}"
# Why: hook args/results can include full tool payloads. Bound traversal before
# JSON encoding so status hooks stay best-effort and cheap.
MAX_JSONABLE_DEPTH = 5
MAX_JSONABLE_ITEMS = 50
MAX_JSONABLE_NODES = 500
MAX_JSONABLE_STRING = 8192
TRUNCATED = "...[truncated]"
SELECTED_KEYS = {
    "on_session_start": ("session_id", "model", "platform"),
    "pre_llm_call": ("session_id", "user_message", "is_first_turn", "model", "platform", "sender_id"),
    "post_llm_call": ("session_id", "user_message", "assistant_response", "model", "platform"),
    "pre_tool_call": ("session_id", "task_id", "tool_call_id", "tool_name", "args"),
    "post_tool_call": ("session_id", "task_id", "tool_call_id", "tool_name", "args", "result", "duration_ms"),
    "pre_approval_request": ("command", "description", "pattern_key", "pattern_keys", "session_key", "surface"),
    "post_approval_response": ("command", "description", "pattern_key", "pattern_keys", "session_key", "surface", "choice"),
    "on_session_end": ("session_id",),
    "on_session_finalize": ("session_id", "platform"),
    "on_session_reset": ("session_id", "platform"),
}


def _truncate_string(value: str) -> str:
    if len(value) <= MAX_JSONABLE_STRING:
        return value
    return value[:MAX_JSONABLE_STRING] + TRUNCATED


def _jsonable(value: Any, depth: int = 0, budget: Optional[list[int]] = None) -> Any:
    if budget is None:
        budget = [MAX_JSONABLE_NODES]
    if budget[0] <= 0:
        return TRUNCATED
    budget[0] -= 1
    if depth > MAX_JSONABLE_DEPTH:
        return _truncate_string(repr(value))
    if value is None or isinstance(value, (int, float, bool)):
        return value
    if isinstance(value, str):
        return _truncate_string(value)
    if isinstance(value, dict):
        out: dict[str, Any] = {}
        for index, (k, v) in enumerate(value.items()):
            if index >= MAX_JSONABLE_ITEMS:
                out[TRUNCATED] = True
                break
            out[_truncate_string(str(k))] = _jsonable(v, depth + 1, budget)
        return out
    if isinstance(value, (list, tuple, set)):
        out = []
        for index, item in enumerate(value):
            if index >= MAX_JSONABLE_ITEMS:
                out.append(TRUNCATED)
                break
            out.append(_jsonable(item, depth + 1, budget))
        return out
    return _truncate_string(repr(value))


def _pane_env() -> Optional[dict[str, str]]:
    if bound_client_env is None:
        return dict(os.environ)
    # The shared gateway's os.environ is whichever pane started it; unbound events have no proven pane.
    client_env = bound_client_env()
    if client_env is None:
        return None
    env = dict(client_env)
    env.setdefault("ORCA_PANE_KEY", env.get("${ORCA_SCRUB_SAFE_PANE_ENV}", ""))
    env.setdefault("ORCA_AGENT_LAUNCH_TOKEN", env.get("${ORCA_SCRUB_SAFE_LAUNCH_ENV}", ""))
    return env


def _endpoint_env(env: dict[str, str]) -> dict[str, str]:
    endpoint = env.get("ORCA_AGENT_HOOK_ENDPOINT", "")
    if endpoint and os.path.isfile(endpoint):
        try:
            with open(endpoint, "r", encoding="utf-8") as f:
                for raw in f:
                    line = raw.strip()
                    if not line or line.startswith("#"):
                        continue
                    if line.startswith("set "):
                        line = line[4:]
                    key, sep, value = line.partition("=")
                    if sep and key:
                        env[key] = value
        except OSError:
            pass
    return env


def _post_to_orca(payload: dict[str, Any]) -> None:
    pane_env = _pane_env()
    if pane_env is None:
        return
    env = _endpoint_env(pane_env)
    port = env.get("ORCA_AGENT_HOOK_PORT", "")
    token = env.get("ORCA_AGENT_HOOK_TOKEN", "")
    pane_key = env.get("ORCA_PANE_KEY", "")
    if not port or not token or not pane_key:
        return
    body = {
        "paneKey": pane_key,
        "launchToken": env.get("ORCA_AGENT_LAUNCH_TOKEN", ""),
        "tabId": env.get("ORCA_TAB_ID", ""),
        "worktreeId": env.get("ORCA_WORKTREE_ID", ""),
        "env": env.get("ORCA_AGENT_HOOK_ENV", ""),
        "version": env.get("ORCA_AGENT_HOOK_VERSION", ""),
        "payload": payload,
    }
    data = json.dumps(body, separators=(",", ":")).encode("utf-8")
    request = urllib.request.Request(
        f"http://127.0.0.1:{port}/hook/hermes",
        data=data,
        method="POST",
        headers={
            "Content-Type": "application/json",
            "X-Orca-Agent-Hook-Token": token,
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=0.75):
            pass
    except (OSError, urllib.error.URLError):
        return


def _payload_for_event(event_name: str, kwargs: dict[str, Any]) -> dict[str, Any]:
    payload: dict[str, Any] = {"hook_event_name": event_name}
    try:
        payload["cwd"] = os.getcwd()
    except OSError:
        # Hermes Kanban cleanup can delete a worker's cwd; a status hook must not fail the tool.
        pass
    for key in SELECTED_KEYS.get(event_name, ()):
        if key in kwargs:
            payload[key] = _jsonable(kwargs[key])
    if "user_message" in payload:
        payload["prompt"] = payload["user_message"]
    if "assistant_response" in payload:
        payload["last_assistant_message"] = payload["assistant_response"]
    if "args" in payload:
        payload["tool_input"] = payload["args"]
    if event_name in {"pre_approval_request", "post_approval_response"}:
        payload["tool_name"] = "approval"
        payload["tool_input"] = {
            "command": payload.get("command", ""),
            "description": payload.get("description", ""),
        }
    return payload


def _published_env(session_id: str) -> Optional[dict[str, Any]]:
    if not SESSION_ID.fullmatch(session_id or ""):
        return None
    try:
        with open(os.path.join(SESSION_ENV_DIR, session_id + ".json"), "r", encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def _session_env(session_id: str) -> dict[str, Any]:
    published = _published_env(session_id)
    if published is None and _bound_session_value is not None:
        # A delegated subagent, and the rest of a turn Hermes compressed, run under a new session id;
        # the chat id bound to this turn still names the chat (never the gateway's os.environ copy).
        chat_id = _bound_session_value("HERMES_SESSION_CHAT_ID")
        if isinstance(chat_id, str) and chat_id != session_id:
            published = _published_env(chat_id)
    # A gateway restarted from a chat's tool keeps that chat's token: only the file's own may reach a tool.
    env = dict(published) if isinstance(published, dict) else {}
    env.setdefault("${ORCA_AGENT_SESSION_TOOL_TOKEN_ENV}", None)
    return env


def _make_hook(event_name: str) -> Callable[..., None]:
    def _hook(**kwargs: Any) -> None:
        _post_to_orca(_payload_for_event(event_name, kwargs))

    return _hook


def register(ctx: Any) -> None:
    for event_name in EVENTS:
        ctx.register_hook(event_name, _make_hook(event_name))
    # Hermes before 0.23.1 has no per-session env: its chats' tools keep no Orca identity.
    if not hasattr(ctx, "register_session_env"):
        return
    # Orca reads this process's mark to know its tools get this plugin's session env, so the mark
    # exists only while the env is registered: gone before a retry, and when Hermes unloads it.
    _unmark_loaded()
    try:
        ctx.register_session_env(SESSION_ENV_NAMES, _session_env)
    except ValueError:
        # Another plugin holds one of these names; status hooks still report.
        return
    if hasattr(ctx, "on_unload"):
        ctx.on_unload(_unmark_loaded)
    try:
        os.makedirs(SESSION_ENV_DIR, exist_ok=True)
        with open(LOADED_MARK, "w", encoding="utf-8") as f:
            f.write(GENERATION)
    except OSError:
        pass


def _unmark_loaded() -> None:
    try:
        os.remove(LOADED_MARK)
    except OSError:
        pass
`
}
