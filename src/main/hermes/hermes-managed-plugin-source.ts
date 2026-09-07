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

export function getPluginManifest(): string {
  return [
    `# ${HERMES_PLUGIN_MARKER}`,
    `name: ${HERMES_PLUGIN_NAME}`,
    'version: 1.0.0',
    'description: "Reports Hermes Agent lifecycle events to Orca."',
    'author: "Orca"',
    'kind: standalone',
    'provides_hooks:',
    ...HERMES_EVENTS.map((event) => `  - ${event}`),
    ''
  ].join('\n')
}

export function getPluginInitSource(): string {
  return `# ${HERMES_PLUGIN_MARKER}
from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from typing import Any, Callable, Optional

EVENTS = ${JSON.stringify(HERMES_EVENTS)}
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


def _endpoint_env() -> dict[str, str]:
    env = dict(os.environ)
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
    env = _endpoint_env()
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
    payload: dict[str, Any] = {"hook_event_name": event_name, "cwd": os.getcwd()}
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


def _make_hook(event_name: str) -> Callable[..., None]:
    def _hook(**kwargs: Any) -> None:
        _post_to_orca(_payload_for_event(event_name, kwargs))

    return _hook


def register(ctx: Any) -> None:
    for event_name in EVENTS:
        ctx.register_hook(event_name, _make_hook(event_name))
`
}
