#!/usr/bin/env python3
"""Guarded, subscription-aware launcher for Orca worker-start."""

from __future__ import annotations

import argparse
import datetime as dt
import json
import math
import os
import re
import shlex
import shutil
import subprocess
import sys
import tempfile
import uuid
from pathlib import Path
from typing import Any


DEFAULT_POLICY_PATH = Path(__file__).resolve().with_name("policy.example.json")
MISSING = object()
REMOTE_ROUTING_FLAGS = frozenset((
    "-e", "--environment", "--environment-id", "--pairing-code",
    "--remote", "--remote-host", "--host", "--server", "--ssh", "--relay",
))


class GuardError(Exception):
    def __init__(self, code: str, message: str, details: Any = None):
        super().__init__(message)
        self.code = code
        self.details = details


def json_default(value: Any) -> Any:
    if isinstance(value, dt.datetime):
        return value.isoformat().replace("+00:00", "Z")
    if isinstance(value, Path):
        return str(value)
    raise TypeError(f"Cannot serialize {type(value).__name__}")


def emit(value: dict[str, Any], exit_code: int = 0) -> int:
    print(json.dumps(value, ensure_ascii=False, indent=2, default=json_default))
    return exit_code


def load_json(path: Path, label: str) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8-sig"))
    except FileNotFoundError as exc:
        raise GuardError(f"{label}_missing", f"{label} file not found: {path}") from exc
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise GuardError(f"{label}_invalid", f"Cannot read {label} JSON: {exc}") from exc
    if not isinstance(value, dict):
        raise GuardError(f"{label}_invalid", f"{label} JSON must be an object")
    return value


def parse_time(value: Any) -> dt.datetime | None:
    if not isinstance(value, str) or not value.strip():
        return None
    raw = value.strip()
    if raw.endswith("Z"):
        raw = raw[:-1] + "+00:00"
    try:
        parsed = dt.datetime.fromisoformat(raw)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return None
    return parsed.astimezone(dt.timezone.utc)


def pct(value: Any) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    if not 0 <= value <= 100:
        return None
    return float(value)


def validate_policy(policy: dict[str, Any]) -> None:
    if type(policy.get("schema_version")) is not int or policy["schema_version"] != 1:
        raise GuardError("policy_invalid", "policy schema_version must be 1")
    max_workers = policy.get("max_live_workers")
    if type(max_workers) is not int or max_workers < 1:
        raise GuardError("policy_invalid", "policy max_live_workers must be a positive integer")
    if type(policy.get("quota_schema_version")) is not int or policy["quota_schema_version"] < 1:
        raise GuardError("policy_invalid", "policy quota_schema_version must be a positive integer")
    for name in ("max_snapshot_age_minutes", "recent_dispatch_window_days", "near_reset_tiebreak_minutes"):
        value = policy.get(name)
        try:
            finite = math.isfinite(value)
        except (OverflowError, TypeError):
            finite = False
        if (isinstance(value, bool) or not isinstance(value, (int, float))
                or not finite or value < 0):
            raise GuardError("policy_invalid", f"policy {name} must be a non-negative number")

    providers = policy.get("providers")
    pools = policy.get("quota_pools")
    if not isinstance(providers, dict) or not providers:
        raise GuardError("policy_invalid", "policy providers must be a non-empty object")
    if not isinstance(pools, dict) or not pools:
        raise GuardError("policy_invalid", "policy quota_pools must be a non-empty object")

    supported_field_types = {"string", "nonempty_string", "timestamp", "percentage"}
    for provider, config in providers.items():
        if (not isinstance(provider, str) or not provider.strip() or provider == "auto"
                or not isinstance(config, dict)):
            raise GuardError("policy_invalid", "policy provider entries must have non-empty IDs and object values")
        if not isinstance(config.get("orca_agent"), str) or not config["orca_agent"].strip():
            raise GuardError("policy_invalid", f"provider {provider} must define a non-empty orca_agent")
        pool_id = config.get("pool")
        if not isinstance(pool_id, str) or pool_id not in pools or not isinstance(pools[pool_id], dict):
            raise GuardError("policy_invalid", f"provider {provider} must reference a defined quota pool")
        if pools[pool_id].get("provider") != provider:
            raise GuardError("policy_invalid", f"quota pool {pool_id} provider must match {provider}")
        profiles = config.get("profiles")
        if not isinstance(profiles, dict):
            raise GuardError("policy_invalid", f"provider {provider} profiles must be an object")
        if "verify_with_agy_cli" in config and not isinstance(config["verify_with_agy_cli"], bool):
            raise GuardError("policy_invalid", f"provider {provider} verify_with_agy_cli must be boolean")
        for tier, profile in profiles.items():
            if not isinstance(tier, str) or not isinstance(profile, dict):
                raise GuardError("policy_invalid", f"provider {provider} profiles must map tiers to objects")
            if not isinstance(profile.get("model"), str) or not profile["model"].strip():
                raise GuardError("policy_invalid", f"provider {provider}/{tier} must define a model")
            effort = profile.get("effort")
            if effort is not None and (not isinstance(effort, str) or not effort.strip()):
                raise GuardError("policy_invalid", f"provider {provider}/{tier} effort must be a non-empty string")
        patterns = config.get("denied_model_patterns", [])
        if not isinstance(patterns, list) or any(not isinstance(pattern, str) for pattern in patterns):
            raise GuardError("policy_invalid", f"provider {provider} denied_model_patterns must be a string list")
        for pattern in patterns:
            try:
                re.compile(pattern)
            except re.error as exc:
                raise GuardError("policy_invalid", f"provider {provider} has an invalid denied model regex") from exc

    for pool_id, definition in pools.items():
        if not isinstance(pool_id, str) or not pool_id.strip() or not isinstance(definition, dict):
            raise GuardError("policy_invalid", "policy quota pool definitions must be objects with non-empty IDs")
        pool_provider = definition.get("provider")
        if not isinstance(pool_provider, str) or pool_provider not in providers:
            raise GuardError("policy_invalid", f"quota pool {pool_id} must reference a configured provider")
        fields = definition.get("fields")
        if not isinstance(fields, dict) or any(
            not isinstance(name, str) or not isinstance(kind, str) or kind not in supported_field_types
            for name, kind in fields.items()
        ):
            raise GuardError("policy_invalid", f"quota pool {pool_id} fields must map names to supported types")
        for list_name in ("provenance_required_for", "provenance_fields"):
            names = definition.get(list_name)
            if not isinstance(names, list) or any(not isinstance(name, str) for name in names):
                raise GuardError("policy_invalid", f"quota pool {pool_id} {list_name} must be a string list")
            if any(name not in fields for name in names):
                raise GuardError("policy_invalid", f"quota pool {pool_id} {list_name} names an undefined field")


def validate_quota_snapshot(quota: dict[str, Any], policy: dict[str, Any]) -> None:
    expected_version = policy["quota_schema_version"]
    if type(quota.get("schema_version")) is not int or quota.get("schema_version") != expected_version:
        raise GuardError("quota_invalid", f"quota JSON schema_version must be {expected_version}",
                         {"expected_schema_version": expected_version})
    pools = quota.get("pools")
    definitions = policy["quota_pools"]
    if not isinstance(pools, dict):
        raise GuardError("quota_invalid", "quota JSON pools must be an object",
                         {"allowed_pool_keys": sorted(definitions)})

    unknown_pool_keys = sorted(key for key in pools if key not in definitions)
    if unknown_pool_keys:
        raise GuardError("quota_invalid", "quota JSON contains unknown pool keys",
                         {"unknown_pool_keys": unknown_pool_keys,
                          "allowed_pool_keys": sorted(definitions)})

    for pool_key, pool in pools.items():
        definition = definitions[pool_key]
        fields = definition["fields"]
        if not isinstance(pool, dict):
            raise GuardError("quota_invalid", f"quota pool {pool_key} must be an object",
                             {"pool": pool_key, "allowed_pool_fields": sorted(fields)})
        unknown_fields = sorted(key for key in pool if key not in fields)
        if unknown_fields:
            raise GuardError("quota_invalid", f"quota pool {pool_key} contains unknown fields",
                             {"pool": pool_key, "unknown_pool_fields": unknown_fields,
                              "allowed_pool_fields": sorted(fields)})

        actual_provider = pool.get("provider")
        expected_provider = definition["provider"]
        if actual_provider is not None and actual_provider != expected_provider:
            raise GuardError("quota_invalid", f"quota pool {pool_key} provider does not match policy",
                             {"pool": pool_key, "expected_provider": expected_provider,
                              "actual_provider": actual_provider})
        for field, kind in fields.items():
            value = pool.get(field)
            if value is None:
                continue
            valid = (
                isinstance(value, str) if kind == "string" else
                isinstance(value, str) and bool(value.strip()) if kind == "nonempty_string" else
                parse_time(value) is not None if kind == "timestamp" else
                pct(value) is not None if kind == "percentage" else False
            )
            if not valid:
                raise GuardError("quota_invalid", f"quota pool {pool_key} field {field} has an invalid value",
                                 {"pool": pool_key, "field": field, "expected_type": kind})

        provenance_triggers = definition["provenance_required_for"]
        if any(pool.get(field) is not None for field in provenance_triggers):
            missing = [field for field in definition["provenance_fields"]
                       if pool.get(field) is None or (
                           isinstance(pool.get(field), str) and not pool[field].strip()
                       )]
            if missing:
                raise GuardError("quota_invalid", f"quota pool {pool_key} usage requires provenance",
                                 {"pool": pool_key, "missing_provenance": missing,
                                  "required": definition["provenance_fields"]})


def read_state(state_dir: Path) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    path = state_dir / "routing-state.json"
    if not path.exists():
        return {"schema_version": 1, "events": []}, []
    data = load_json(path, "state")
    events = data.get("events")
    if data.get("schema_version") != 1 or not isinstance(events, list):
        raise GuardError("state_invalid", f"Unsupported or malformed state file: {path}")
    return data, [event for event in events if isinstance(event, dict)]


def default_state_dir() -> Path:
    if os.name == "nt":
        root = os.environ.get("LOCALAPPDATA")
        return Path(root) / "Orca" / "subscription-router" if root else (
            Path.home() / "AppData" / "Local" / "Orca" / "subscription-router"
        )
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / "Orca" / "subscription-router"
    root = os.environ.get("XDG_STATE_HOME")
    return (Path(root) if root else Path.home() / ".local" / "state") / "orca" / "subscription-router"


def validate_local_execution_context() -> None:
    for name in ("ORCA_ENVIRONMENT", "ORCA_PAIRING_CODE", "ORCA_REMOTE_PAIRING"):
        if os.environ.get(name):
            raise GuardError("remote_context_unsupported", f"{name} selects a remote Orca context; this example only operates on its execution host")

    raw_prefix = os.environ.get("ORCA_CLI_COMMAND")
    if not raw_prefix:
        return
    try:
        prefix = [raw_prefix] if Path(raw_prefix).is_file() else shlex.split(raw_prefix, posix=True)
    except ValueError as exc:
        raise GuardError("orca_command_invalid", f"Cannot parse ORCA_CLI_COMMAND: {exc}") from exc
    for token in prefix:
        flag = token.split("=", 1)[0].casefold()
        if flag in REMOTE_ROUTING_FLAGS:
            raise GuardError("remote_context_unsupported", f"ORCA_CLI_COMMAND contains remote-routing flag {flag}")


def recent_counts(
    events: list[dict[str, Any]], now: dt.datetime, days: int, provider_ids: set[str],
) -> dict[str, int]:
    cutoff = now - dt.timedelta(days=days)
    counts: dict[str, int] = {}
    for event in events:
        stamp = parse_time(event.get("time"))
        provider = event.get("provider")
        if (
            stamp is not None and cutoff <= stamp <= now
            and isinstance(provider, str) and provider in provider_ids
            and event.get("outcome") in ("success", "unknown")
        ):
            counts[provider] = counts.get(provider, 0) + 1
    return counts


def pool_status(pool: dict[str, Any] | None, now: dt.datetime, max_age_minutes: int) -> dict[str, Any]:
    data = pool if isinstance(pool, dict) else {}
    observed = parse_time(data.get("observed_at"))
    source = data.get("source")
    source_known = isinstance(source, str) and bool(source.strip())
    cooldown = parse_time(data.get("cooldown_until"))
    cooldown_active = cooldown is not None and cooldown > now
    age_minutes = (now - observed).total_seconds() / 60 if observed else None
    fresh_provenance = (
        observed is not None and 0 <= age_minutes <= max_age_minutes and source_known
    )

    windows = (
        ("five_hour_used_pct", "five_hour_resets_at"),
        ("weekly_used_pct", "weekly_resets_at"),
    )
    depleted = False
    scores: list[float] = []
    reset_times: list[dt.datetime] = []
    resets_elapsed = False
    for used_key, reset_key in windows:
        used = pct(data.get(used_key))
        reset = parse_time(data.get(reset_key))
        if reset is not None:
            if reset <= now:
                resets_elapsed = True
                continue
            reset_times.append(reset)
        if used == 100 and (reset is not None or fresh_provenance):
            depleted = True
        if used is not None and (reset is None or reset > now):
            scores.append(100.0 - used)

    fresh = (
        fresh_provenance and len(scores) == 2 and not resets_elapsed
    )
    return {
        "cooldown_active": cooldown_active,
        "depleted": depleted,
        "fresh_comparable": fresh,
        "remaining_score": min(scores) if fresh else None,
        "age_minutes": age_minutes,
        "next_reset": min(reset_times) if reset_times else None,
    }


def quota_pool_map(quota: dict[str, Any]) -> dict[str, dict[str, Any]]:
    pools = quota.get("pools", {})
    if not isinstance(pools, dict):
        raise GuardError("quota_invalid", "quota JSON pools must be an object")
    return {key: value for key, value in pools.items() if isinstance(value, dict)}


def resolve_model(
    policy: dict[str, Any], tier: str, provider_request: str, model_request: str | None,
) -> tuple[str, dict[str, Any]]:
    providers = policy["providers"]
    if provider_request != "auto" and provider_request not in providers:
        raise GuardError("provider_invalid", f"Provider is not configured: {provider_request}")

    def denied(provider: str, model: str) -> bool:
        patterns = providers[provider].get("denied_model_patterns", [])
        return any(re.search(pattern, model) is not None for pattern in patterns)

    if model_request:
        all_matches = [
            (provider, profile_tier, profile)
            for provider, config in providers.items()
            for profile_tier, profile in config.get("profiles", {}).items()
            if profile.get("model") == model_request
        ]
        if provider_request != "auto":
            if denied(provider_request, model_request):
                raise GuardError("model_denied", f"Model is denied by provider policy: {model_request}")
            matches = [match for match in all_matches if match[0] == provider_request]
            if not matches and all_matches:
                raise GuardError("model_provider_mismatch", f"{model_request} is not configured for provider {provider_request}")
        else:
            matches = [match for match in all_matches if not denied(match[0], model_request)]
            if len({provider for provider, _, _ in matches}) > 1:
                raise GuardError("model_provider_required", f"{model_request} is configured for multiple providers; select --provider")
        if not matches:
            if any(denied(provider, model_request) for provider in providers):
                raise GuardError("model_denied", f"Model is denied by provider policy: {model_request}")
            raise GuardError("model_not_approved", f"Model is not on the approved list: {model_request}")
        tier_matches = [match for match in matches if match[1] == tier]
        if not tier_matches:
            approved_tiers = sorted({profile_tier for _, profile_tier, _ in matches})
            raise GuardError("model_tier_mismatch", f"{model_request} is approved for {', '.join(approved_tiers)}, not {tier}")
        provider, _, profile = tier_matches[0]
        return provider, profile
    if provider_request != "auto":
        profile = providers.get(provider_request, {}).get("profiles", {}).get(tier)
        if not profile:
            raise GuardError("profile_missing", f"No approved {provider_request}/{tier} profile")
        if denied(provider_request, profile["model"]):
            raise GuardError("model_denied", f"Model is denied by provider policy: {profile['model']}")
        return provider_request, profile
    raise GuardError("route_required", "Auto provider selection requires quota/state routing")


def choose_route(
    policy: dict[str, Any],
    quota: dict[str, Any],
    events: list[dict[str, Any]],
    tier: str,
    provider_request: str,
    model_request: str | None,
    now: dt.datetime | None = None,
) -> dict[str, Any]:
    now = now or dt.datetime.now(dt.timezone.utc)
    if tier not in ("simple", "complex"):
        raise GuardError("tier_invalid", "tier must be simple or complex")
    providers = policy["providers"]
    if provider_request != "auto" and provider_request not in providers:
        raise GuardError("provider_invalid", f"provider is not configured: {provider_request}")
    pools = quota_pool_map(quota)
    max_age = int(policy.get("max_snapshot_age_minutes", 60))
    counts = recent_counts(events, now, int(policy.get("recent_dispatch_window_days", 7)), set(providers))
    assessments: dict[str, dict[str, Any]] = {}

    if model_request:
        provider, profile = resolve_model(policy, tier, provider_request, model_request)
        assessments[provider] = pool_status(pools.get(providers[provider]["pool"]), now, max_age)
        selection_reason = "explicit_model"
    elif provider_request != "auto":
        provider, profile = resolve_model(policy, tier, provider_request, None)
        assessments[provider] = pool_status(pools.get(providers[provider]["pool"]), now, max_age)
        selection_reason = "explicit_provider"
    else:
        candidates = [p for p, config in providers.items()
                      if tier in config.get("profiles", {})
                      and not any(re.search(pattern, config["profiles"][tier]["model"]) is not None
                                  for pattern in config.get("denied_model_patterns", []))]
        if not candidates:
            raise GuardError("profile_missing", f"No providers have an allowed {tier} profile")
        for candidate in candidates:
            assessments[candidate] = pool_status(pools.get(providers[candidate]["pool"]), now, max_age)
        eligible = [p for p in candidates
                    if not assessments[p]["cooldown_active"] and not assessments[p]["depleted"]]
        if not eligible:
            raise GuardError("no_available_pool", "All eligible subscription pools are depleted or in cooldown",
                             {"pools": assessments})
        fresh_eligible = [p for p in eligible if assessments[p]["fresh_comparable"]]
        if fresh_eligible:
            def quota_key(candidate: str) -> tuple[Any, ...]:
                status = assessments[candidate]
                reset = status["next_reset"]
                near_minutes = float(policy.get("near_reset_tiebreak_minutes", 30))
                near_rank, reset_seconds = 1, float("inf")
                if reset is not None:
                    seconds = max(0.0, (reset - now).total_seconds())
                    if seconds <= near_minutes * 60:
                        near_rank, reset_seconds = 0, seconds
                return (-float(status["remaining_score"]), near_rank, reset_seconds,
                        counts.get(candidate, 0), list(providers).index(candidate))
            provider = min(fresh_eligible, key=quota_key)
            selection_reason = "quota_snapshot"
        else:
            provider = min(eligible, key=lambda p: (counts.get(p, 0), list(providers).index(p)))
            selection_reason = "quota_unknown"
        profile = providers[provider]["profiles"][tier]

    if any(re.search(pattern, profile["model"]) is not None
           for pattern in providers[provider].get("denied_model_patterns", [])):
        raise GuardError("model_denied", f"Model is denied by provider policy: {profile['model']}")
    pool_id = providers[provider]["pool"]
    assessment = assessments.get(provider) or pool_status(pools.get(pool_id), now, max_age)
    if assessment["cooldown_active"]:
        raise GuardError("pool_cooldown", f"Pool {pool_id} is in cooldown", {"pool": assessment})
    if assessment["depleted"]:
        raise GuardError("pool_depleted", f"Pool {pool_id} has a known exhausted window", {"pool": assessment})
    if not assessment["fresh_comparable"]:
        selection_reason = "quota_unknown"

    return {
        "provider": provider, "pool": pool_id, "agent": providers[provider]["orca_agent"],
        "model": profile["model"], "effort": profile.get("effort"),
        "selection_reason": selection_reason,
        "quota": {key: assessment[key] for key in
                  ("cooldown_active", "depleted", "fresh_comparable", "remaining_score", "age_minutes")},
        "recent_dispatches": counts.get(provider, 0),
    }


def validate_task_spec(spec: str) -> None:
    if not spec.strip():
        raise GuardError("spec_empty", "Task spec must not be blank")
    required = ("target", "change", "constraints", "ownership", "observable acceptance")
    found: set[str] = set()
    for raw_line in spec.splitlines():
        line = raw_line.strip().lstrip("#>*- \t").replace("**", "").replace("__", "").strip()
        match = re.match(r"^(target|change|constraints|ownership|observable acceptance)\s*(?::|$)", line, re.I)
        if match:
            found.add(match.group(1).casefold())
    missing = [label for label in required if label not in found]
    if missing:
        raise GuardError("spec_fields_missing", "Task spec is missing required fields", {"missing": missing})


def read_spec(path: str | None, dry_run: bool) -> str | None:
    if path is None:
        if dry_run:
            return None
        raise GuardError("spec_required", "--spec-file is required for a real worker launch")
    try:
        with Path(path).open("r", encoding="utf-8-sig", newline="") as handle:
            spec = handle.read()
    except (OSError, UnicodeError) as exc:
        raise GuardError("spec_read_failed", f"Cannot read Task spec: {exc}") from exc
    validate_task_spec(spec)
    return spec


def wrap_task_spec(spec: str) -> str:
    marker = uuid.uuid4().hex
    return (
        "[Coordinator execution contract: applies to this worker only]\n"
        "Complete only the assigned Task. Do not start, ask for, or invoke any other agent, "
        "agent CLI, native subagent, parallel model, or provider session. Do not create a new "
        "Orca Run or recursively delegate. If more work seems needed, report it to the coordinator "
        "and wait for direction.\n"
        "For AGY, never call invoke_subagent or define_subagent; do not create research/browser "
        "subagents; do not use /boost or /teamwork; do not switch models or fall back to Flash.\n"
        f"[BEGIN ORIGINAL TASK SPEC {marker}; preserve and execute its full contents]\n"
        + spec
        + "\n[Coordinator execution contract reaffirmed: do not delegate, start another agent, "
        "agent CLI, native subagent, parallel model, or provider session. For AGY, never call "
        "invoke_subagent/define_subagent, research/browser subagents, /boost, /teamwork, switch "
        "models, or fall back to Flash.]\n"
        + f"[END ORIGINAL TASK SPEC {marker}]\n"
    )


def resolve_executable(name: str) -> str:
    candidate = Path(name)
    if candidate.is_file():
        return str(candidate.resolve())
    found = shutil.which(name)
    if found:
        return str(Path(found).resolve())
    raise GuardError("executable_not_found", f"Selected executable cannot be found: {name}")


def resolve_orca_command() -> list[str]:
    raw = os.environ.get("ORCA_CLI_COMMAND")
    if raw:
        candidate = Path(raw)
        try:
            pieces = [raw] if candidate.is_file() else shlex.split(raw, posix=True)
        except ValueError as exc:
            raise GuardError("orca_command_invalid", f"Cannot parse ORCA_CLI_COMMAND: {exc}") from exc
        if not pieces:
            raise GuardError("orca_command_invalid", "ORCA_CLI_COMMAND is empty")
        pieces[0] = resolve_executable(pieces[0])
        return pieces
    if os.environ.get("ORCA_DEV_REPO_ROOT"):
        executable = "orca-dev"
    elif sys.platform.startswith("linux"):
        executable = "orca-ide"
    elif os.name == "nt":
        executable = "orca.exe"
    else:
        executable = "orca"
    return [resolve_executable(executable)]


def resolve_agy_executable() -> str:
    found = shutil.which("agy")
    if found:
        return str(Path(found).resolve())
    if os.name == "nt":
        local_app_data = os.environ.get("LOCALAPPDATA")
        if local_app_data:
            candidate = Path(local_app_data) / "agy" / "bin" / "agy.exe"
            if candidate.is_file():
                return str(candidate.resolve())
    raise GuardError("agy_not_found", "Official agy CLI was not found on PATH or the Windows install path")


def invoke(argv: list[str]) -> subprocess.CompletedProcess[str]:
    try:
        return subprocess.run(argv, shell=False, capture_output=True, text=True,
                              encoding="utf-8", errors="replace", check=False)
    except OSError as exc:
        raise GuardError("command_cannot_run", f"Selected command cannot run: {exc}") from exc


def is_keepalive(obj: Any) -> bool:
    if not isinstance(obj, dict):
        return False
    if "_keepalive" in obj or "_heartbeat" in obj:
        return True
    marker = obj.get("type", obj.get("kind", obj.get("event")))
    return isinstance(marker, str) and marker.casefold() in ("keepalive", "heartbeat", "_keepalive", "_heartbeat")


def parse_cli_json(stdout: str, command_name: str, reject_ok_false: bool = True) -> dict[str, Any]:
    decoder = json.JSONDecoder()
    candidates: list[dict[str, Any]] = []
    position = 0
    while position < len(stdout):
        next_object = min((i for i in (stdout.find("{", position), stdout.find("[", position)) if i >= 0),
                          default=-1)
        if next_object < 0:
            break
        try:
            value, end = decoder.raw_decode(stdout, next_object)
        except json.JSONDecodeError:
            position = next_object + 1
            continue
        if isinstance(value, dict) and not is_keepalive(value):
            candidates.append(value)
        position = max(end, next_object + 1)
    if not candidates:
        raise GuardError(f"{command_name}_invalid_json", f"{command_name} did not return a usable JSON receipt",
                         {"stdout": stdout})
    preferred = [item for item in candidates if "ok" in item or "result" in item or "receipt" in item]
    data = preferred[-1] if preferred else candidates[-1]
    if reject_ok_false and data.get("ok") is False:
        raise GuardError(f"{command_name}_failed", f"{command_name} returned ok=false", data)
    return data

def list_worker_liveness(
    orca_prefix: list[str], run_id: str, max_live_workers: int,
) -> dict[str, Any]:
    cursor: str | None = None
    seen: set[str] = set()
    live = rows = pages = 0
    while True:
        argv = [*orca_prefix, "orchestration", "worker-list", "--include-remote"]
        argv.extend(["--run", run_id])
        if cursor:
            argv.extend(["--cursor", cursor])
        argv.append("--json")
        completed = invoke(argv)
        if completed.returncode != 0:
            raise GuardError("worker_list_failed", "Cannot confirm worker liveness; refusing to launch",
                             {"returncode": completed.returncode, "stdout": completed.stdout,
                              "stderr": completed.stderr})
        payload = parse_cli_json(completed.stdout, "worker_list")
        result = payload.get("result", payload)
        workers = result.get("workers") if isinstance(result, dict) else None
        page = result.get("page") if isinstance(result, dict) else None
        if not isinstance(workers, list) or not isinstance(page, dict):
            raise GuardError("worker_list_unverifiable", "worker-list response lacks workers/page")
        pages += 1
        for worker in workers:
            if not isinstance(worker, dict):
                raise GuardError("worker_liveness_unknown", "worker-list contains a malformed worker row")
            projection = worker.get("projection")
            liveness = projection.get("liveness") if isinstance(projection, dict) else None
            verdict = liveness.get("verdict") if isinstance(liveness, dict) else None
            dispatch_id = worker.get("dispatchId")
            identity = str(dispatch_id) if dispatch_id is not None else f"row-{pages}-{rows}"
            if identity in seen:
                continue
            seen.add(identity)
            rows += 1
            if verdict == "live":
                live += 1
            elif verdict == "exited":
                continue
            else:
                raise GuardError("worker_liveness_unknown",
                                 "Worker liveness is unknown or unverifiable; refusing to treat it as dead",
                                 {"dispatchId": dispatch_id, "verdict": verdict})
        has_more = page.get("hasMore")
        if has_more is False:
            break
        next_cursor = page.get("nextCursor")
        if has_more is not True or not isinstance(next_cursor, str) or not next_cursor:
            raise GuardError("worker_list_unverifiable",
                             "worker-list pagination state is unknown; refusing to launch", {"page": page})
        cursor = next_cursor
    if live >= max_live_workers:
        raise GuardError("worker_limit_reached", f"At least {max_live_workers} live workers are already active in this Run",
                         {"live_workers": live, "max_live_workers": max_live_workers,
                          "rows_checked": rows, "pages": pages, "run": run_id})
    return {"live_workers": live, "rows_checked": rows, "pages": pages}


def agy_model_is_listed(model: str) -> dict[str, Any]:
    executable = resolve_agy_executable()
    completed = invoke([executable, "models"])
    if completed.returncode != 0:
        raise GuardError("agy_models_failed", "Official agy models could not confirm the model; refusing launch",
                         {"returncode": completed.returncode, "stdout": completed.stdout,
                          "stderr": completed.stderr})
    token = re.compile(rf"(?<![A-Za-z0-9_.-]){re.escape(model)}(?![A-Za-z0-9_.-])")
    if not token.search(completed.stdout):
        raise GuardError("agy_model_unavailable", "Approved Argon model is absent from current agy models output",
                         {"model": model, "stdout": completed.stdout})
    return {"model_confirmed": model}


def find_nested_value(data: Any, names: set[str]) -> Any:
    if isinstance(data, dict):
        for key, value in data.items():
            if key.casefold() in names:
                return value
        for value in data.values():
            found = find_nested_value(value, names)
            if found is not MISSING:
                return found
    elif isinstance(data, list):
        for value in data:
            found = find_nested_value(value, names)
            if found is not MISSING:
                return found
    return MISSING


def find_launch_pair(data: Any) -> dict[str, Any] | None:
    if isinstance(data, dict):
        launch = data.get("launch")
        if isinstance(launch, dict) and ("requested" in launch or "effective" in launch):
            return launch
        if "requested" in data and "effective" in data:
            return data
        for value in data.values():
            found = find_launch_pair(value)
            if found is not None:
                return found
    elif isinstance(data, list):
        for value in data:
            found = find_launch_pair(value)
            if found is not None:
                return found
    return None


def field_from_launch(block: Any, aliases: set[str]) -> Any:
    if not isinstance(block, dict):
        return MISSING
    for key, value in block.items():
        if key.casefold() in aliases:
            if isinstance(value, dict):
                for id_key in ("id", "name", "value"):
                    if isinstance(value.get(id_key), str):
                        return value[id_key]
            return value
    for value in block.values():
        found = find_nested_value(value, aliases)
        if found is not MISSING:
            return found
    return MISSING


def verify_launch(payload: dict[str, Any], plan: dict[str, Any]) -> dict[str, Any]:
    pair = find_launch_pair(payload)
    if pair is None or not isinstance(pair.get("requested"), dict) or not isinstance(pair.get("effective"), dict):
        return {"status": "unconfirmed", "mismatches": ["launch.requested/effective missing"]}
    requested, effective = pair["requested"], pair["effective"]
    aliases = {"agent": {"agent", "agentid"}, "model": {"model", "modelid"}, "effort": {"effort"}}
    req_agent = field_from_launch(requested, aliases["agent"])
    eff_agent = field_from_launch(effective, aliases["agent"])
    req_model = field_from_launch(requested, aliases["model"])
    eff_model = field_from_launch(effective, aliases["model"])
    req_effort = field_from_launch(requested, aliases["effort"])
    eff_effort = field_from_launch(effective, aliases["effort"])
    mismatches: list[str] = []
    for label, value, expected in (
        ("requested agent", req_agent, plan["agent"]),
        ("effective agent", eff_agent, plan["agent"]),
        ("requested model", req_model, plan["model"]),
        ("effective model", eff_model, plan["model"]),
    ):
        if value != expected:
            mismatches.append(label)
    expected_effort = plan.get("effort")
    if expected_effort is None:
        if req_effort not in (MISSING, None, ""):
            mismatches.append("unexpected requested effort")
        if eff_effort not in (MISSING, None, ""):
            mismatches.append("unexpected effective effort")
    else:
        if req_effort != expected_effort:
            mismatches.append("requested effort")
        if eff_effort != expected_effort:
            mismatches.append("effective effort")
    def shown(value: Any) -> Any:
        return None if value is MISSING else value
    return {
        "status": "confirmed" if not mismatches else "unconfirmed",
        "mismatches": mismatches,
        "requested": {"agent": shown(req_agent), "model": shown(req_model), "effort": shown(req_effort)},
        "effective": {"agent": shown(eff_agent), "model": shown(eff_model), "effort": shown(eff_effort)},
    }


def build_worker_start_argv(
    orca_prefix: list[str], plan: dict[str, Any], spec: str, worktree: str, run_id: str | None,
) -> list[str]:
    argv = [
        *orca_prefix, "orchestration", "worker-start", "--spec", spec,
        "--worktree", worktree, "--agent", plan["agent"], "--model", plan["model"],
    ]
    if plan.get("effort") is not None:
        argv.extend(["--effort", plan["effort"]])
    if run_id:
        argv.extend(["--run", run_id])
    argv.append("--json")
    return argv


def lifecycle_statuses(payload: Any) -> list[str]:
    statuses: list[str] = []

    def visit(value: Any) -> None:
        if isinstance(value, dict):
            for key, child in value.items():
                if key.casefold() in {"outcome", "status", "stage", "state"} and isinstance(child, str):
                    statuses.append(child.strip().casefold())
                visit(child)
        elif isinstance(value, list):
            for child in value:
                visit(child)

    visit(payload)
    return statuses


def has_explicit_unknown_status(payload: Any) -> bool:
    return any(status in {"unknown", "outcome_unknown", "unverifiable"}
               for status in lifecycle_statuses(payload))


def has_explicit_failed_status(payload: Any) -> bool:
    return any(status in {"failed", "failure", "error", "rejected", "cancelled", "canceled"}
               for status in lifecycle_statuses(payload))


def has_ready_status(payload: Any) -> bool:
    return "ready" in lifecycle_statuses(payload)


def _nonempty_resource(value: Any) -> bool:
    if isinstance(value, str):
        return bool(value.strip())
    return value is not None and bool(value)


def has_possible_created_resource(payload: Any) -> bool:
    dispatch_fields = {"dispatchid", "dispatch_id"}
    resource_fields = {
        "resource", "resources", "resourceid", "resource_id",
        "residualresources", "residual_resources",
    }

    def visit(value: Any) -> bool:
        if isinstance(value, dict):
            for key, child in value.items():
                normalized = key.casefold()
                if normalized in dispatch_fields and isinstance(child, str) and child.strip():
                    return True
                if normalized in resource_fields and _nonempty_resource(child):
                    return True
                if visit(child):
                    return True
        elif isinstance(value, list):
            return any(visit(child) for child in value)
        return False

    return visit(payload)


def classify_worker_start_outcome(
    payload: Any,
    parse_error: str | None,
    returncode: int,
    verification: dict[str, Any],
) -> str:
    if parse_error or has_explicit_unknown_status(payload):
        return "unknown"

    if (
        returncode == 0
        and isinstance(payload, dict)
        and payload.get("ok") is True
        and has_ready_status(payload)
        and not has_explicit_failed_status(payload)
        and verification.get("status") == "confirmed"
    ):
        return "success"

    if has_possible_created_resource(payload):
        return "unknown"
    if (
        isinstance(payload, dict) and payload.get("ok") is False
    ) or has_explicit_failed_status(payload) or returncode != 0:
        return "failed"
    # A successful process exit without an explicit ready receipt is unverifiable.
    return "unknown"


def append_state_event(
    state_dir: Path, state: dict[str, Any], plan: dict[str, Any],
    run_id: str | None, payload: Any, outcome: str,
) -> None:
    task_id = find_nested_value(payload, {"taskid", "task_id"})
    dispatch_id = find_nested_value(payload, {"dispatchid", "dispatch_id"})
    receipt_run = find_nested_value(payload, {"runid", "run_id"})
    event = {
        "provider": plan["provider"], "model": plan["model"], "pool": plan["pool"],
        "run": run_id or (receipt_run if isinstance(receipt_run, str) else None),
        "task": task_id if isinstance(task_id, str) else None,
        "dispatch": dispatch_id if isinstance(dispatch_id, str) else None,
        "time": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
        "outcome": outcome,
    }
    state.setdefault("events", []).append(event)
    state_dir.mkdir(parents=True, exist_ok=True)
    temp_path: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w", encoding="utf-8", newline="\n", dir=state_dir,
            prefix=".routing-state-", suffix=".tmp", delete=False,
        ) as handle:
            temp_path = Path(handle.name)
            json.dump(state, handle, ensure_ascii=False, indent=2)
            handle.write("\n")
        os.replace(temp_path, state_dir / "routing-state.json")
    except OSError:
        if temp_path is not None:
            try:
                temp_path.unlink(missing_ok=True)
            except OSError:
                pass
        raise


class JsonArgumentParser(argparse.ArgumentParser):
    def error(self, message: str) -> None:
        raise GuardError("arguments_invalid", message)


def make_parser() -> argparse.ArgumentParser:
    parser = JsonArgumentParser(description="Select and safely launch an Orca subscription worker")
    parser.add_argument("--tier", required=True, choices=("simple", "complex"))
    parser.add_argument("--provider", default="auto", help="auto or a provider ID from the selected policy")
    parser.add_argument("--model")
    parser.add_argument("--spec-file")
    parser.add_argument("--worktree", default="current")
    parser.add_argument("--run")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--quota-file")
    parser.add_argument("--policy-file", default=str(DEFAULT_POLICY_PATH))
    parser.add_argument("--state-dir")
    return parser


def main(argv: list[str] | None = None) -> int:
    try:
        args = make_parser().parse_args(argv)
        validate_local_execution_context()
        policy = load_json(Path(args.policy_file).expanduser(), "policy")
        validate_policy(policy)
        state_dir = Path(args.state_dir).expanduser() if args.state_dir else default_state_dir()
        state, events = read_state(state_dir)
        quota = load_json(Path(args.quota_file), "quota") if args.quota_file else {"pools": {}}
        if args.quota_file:
            validate_quota_snapshot(quota, policy)
        plan = choose_route(policy, quota, events, args.tier, args.provider, args.model)
        spec = read_spec(args.spec_file, args.dry_run)
        request = {
            "tier": args.tier, "provider": plan["provider"], "agent": plan["agent"],
            "model": plan["model"], "effort": plan["effort"], "pool": plan["pool"],
            "selection_reason": plan["selection_reason"], "quota": plan["quota"],
            "recent_dispatches": plan["recent_dispatches"], "worktree": args.worktree,
            "run": args.run, "spec_file": args.spec_file,
        }
        if args.dry_run:
            return emit({
                "ok": True, "dry_run": True, "request": request,
                "checks_skipped": ["agy models", "worker-list", "worker-start"],
                "state_written": False,
            })
        if not isinstance(args.run, str) or not args.run.strip():
            raise GuardError("run_required", "--run must name a Run that was created before this command")
        if spec is None:
            raise GuardError("spec_required", "--spec-file is required")
        orca_prefix = resolve_orca_command()
        provider_config = policy["providers"][plan["provider"]]
        agy_check = agy_model_is_listed(plan["model"]) if provider_config.get("verify_with_agy_cli") else None
        liveness = list_worker_liveness(orca_prefix, args.run, policy["max_live_workers"])
        worker_argv = build_worker_start_argv(
            orca_prefix, plan, wrap_task_spec(spec), args.worktree, args.run,
        )
        completed = invoke(worker_argv)
        parse_error = None
        try:
            payload = parse_cli_json(completed.stdout, "worker_start", reject_ok_false=False)
        except GuardError as exc:
            payload = {"unparsed_receipt": True}
            parse_error = str(exc)
        verification = verify_launch(payload, plan)
        outcome = classify_worker_start_outcome(payload, parse_error, completed.returncode, verification)

        state_written = False
        state_error = None
        if outcome in ("success", "unknown"):
            try:
                append_state_event(state_dir, state, plan, args.run, payload, outcome)
                state_written = True
            except OSError as exc:
                state_error = str(exc)

        response = {
            "ok": outcome == "success" and state_error is None,
            "outcome": outcome, "request": request,
            "checks": {"agy_models": agy_check, "worker_liveness": liveness},
            "launch_verification": verification, "state_written": state_written,
            "state_error": state_error, "receipt": payload,
            "raw_stdout": completed.stdout, "raw_stderr": completed.stderr,
            "returncode": completed.returncode, "retry_attempts": 0,
        }
        if parse_error:
            response["receipt_parse_error"] = parse_error
        if outcome == "unknown":
            response["coordinator_action"] = "Inspect the original worker and receipt; do not retry or clean up automatically."
            return emit(response, 3)
        if outcome == "failed":
            return emit(response, 1)
        if state_error:
            response["coordinator_action"] = "Launch is confirmed; preserve the worker and resolve local state write failure."
            return emit(response, 3)
        return emit(response)
    except GuardError as exc:
        return emit({
            "ok": False, "error": {"code": exc.code, "message": str(exc), "details": exc.details},
            "retry_attempts": 0,
        }, 2)


if __name__ == "__main__":
    raise SystemExit(main())
