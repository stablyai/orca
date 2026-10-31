from __future__ import annotations

import copy
import datetime as dt
import json
import os
import subprocess
import tempfile
import unittest
from contextlib import redirect_stdout
from io import StringIO
from pathlib import Path
from unittest import mock

import route_worker as router


HERE = Path(__file__).resolve().parent
POLICY_PATH = HERE / "policy.example.json"
SNAPSHOT_PATH = HERE / "quota-snapshot.example.json"
EXAMPLE_POLICY = router.load_json(POLICY_PATH, "policy")
EXAMPLE_SNAPSHOT = router.load_json(SNAPSHOT_PATH, "quota")
NOW = dt.datetime(2026, 10, 31, 12, tzinfo=dt.timezone.utc)


def timestamp(value: dt.datetime) -> str:
    return value.isoformat().replace("+00:00", "Z")


def snapshot_for(
    policy: dict, updates: dict[str, dict[str, object]] | None = None,
) -> dict:
    updates = updates or {}
    pools = {}
    for pool_id, definition in policy["quota_pools"].items():
        row = {field: None for field in definition["fields"]}
        row["provider"] = definition["provider"]
        if "reported_group" in row:
            row["reported_group"] = "unknown"
        row.update(updates.get(pool_id, {}))
        pools[pool_id] = row
    return {"schema_version": policy["quota_schema_version"], "pools": pools}


def pool_update(
    policy: dict,
    provider: str,
    *,
    observed_at: dt.datetime = NOW,
    source: str | None = "confirmed UI snapshot",
    five_hour_used_pct: float | None = None,
    weekly_used_pct: float | None = None,
    five_hour_resets_at: dt.datetime | None = None,
    weekly_resets_at: dt.datetime | None = None,
    cooldown_until: dt.datetime | None = None,
) -> dict[str, object]:
    pool_id = policy["providers"][provider]["pool"]
    update: dict[str, object] = {
        "observed_at": timestamp(observed_at) if observed_at else None,
        "source": source,
        "five_hour_used_pct": five_hour_used_pct,
        "weekly_used_pct": weekly_used_pct,
        "five_hour_resets_at": timestamp(five_hour_resets_at) if five_hour_resets_at else None,
        "weekly_resets_at": timestamp(weekly_resets_at) if weekly_resets_at else None,
        "cooldown_until": timestamp(cooldown_until) if cooldown_until else None,
    }
    return {pool_id: update}


def generic_policy() -> dict:
    policy = copy.deepcopy(EXAMPLE_POLICY)
    source_provider = policy["providers"]["codex"]
    source_pool = policy["quota_pools"]["codex-subscription"]
    policy["providers"] = {
        "alpha": {
            **copy.deepcopy(source_provider),
            "orca_agent": "agent-a",
            "pool": "pool-a",
            "denied_model_patterns": ["(?i)blocked"],
            "profiles": {"simple": {"model": "alpha-model"}},
        },
        "beta": {
            **copy.deepcopy(source_provider),
            "orca_agent": "agent-b",
            "pool": "pool-b",
            "denied_model_patterns": [],
            "profiles": {"simple": {"model": "beta-model"}},
        },
    }
    policy["quota_pools"] = {
        "pool-a": {**copy.deepcopy(source_pool), "provider": "alpha"},
        "pool-b": {**copy.deepcopy(source_pool), "provider": "beta"},
    }
    return policy


RUN_ID = "prebound-run"
LOCAL_ENV = {"ORCA_ENVIRONMENT": "", "ORCA_PAIRING_CODE": "", "ORCA_REMOTE_PAIRING": "", "ORCA_CLI_COMMAND": ""}
SPEC_TEXT = "Target: t\nChange: c\nConstraints: none\nOwnership: o\nObservable acceptance: a\n"


def worker_row(dispatch_id: str, verdict: str) -> dict:
    return {
        "dispatchId": dispatch_id, "taskId": f"task-{dispatch_id}", "runId": RUN_ID,
        "workerState": "running", "dispatchStatus": "dispatched", "agentTerminalHandle": None,
        "terminalState": "active", "resource": None,
        "projection": {"host": {"id": "local"}, "stage": {"activity": "working"},
                       "liveness": {"verdict": verdict}, "nextAction": {"argv": []}},
    }


def worker_page(rows: list[dict], next_cursor: str | None = None, **extra: object) -> dict:
    return {
        "workers": rows, "counts": {"active": len(rows)}, "scope": {"run": RUN_ID, "source": "flag"},
        "page": {"hasMore": next_cursor is not None, "nextCursor": next_cursor, "total": len(rows)},
        **extra,
    }


def start_receipt(state: str, dispatch_id: str, effective: bool = True, **extra: object) -> dict:
    selection = {"agent": "codex", "model": "gpt-6-luna", "effort": None}
    return {"ok": True, "result": {
        "runId": RUN_ID, "taskId": f"task-{dispatch_id}", "dispatchId": dispatch_id, "state": state,
        "effects": [], "residualResources": [],
        "launch": {"requested": selection, "effective": dict(selection) if effective else None},
        **extra,
    }}


def full_json(body: dict) -> str:
    return json.dumps({"id": "req-1", **body, "_meta": {"runtimeId": "runtime-1"}},
                      ensure_ascii=False, indent=2) + "\n"


class FakeOrcaCli:
    """subprocess.run boundary shaped like Orca's printers: concise JSON unless --full is passed."""

    def __init__(self, pages: list[dict], start: dict | None = None, times_out: str | None = None,
                 partial_output: tuple[object, object] = (None, None)) -> None:
        self.pages, self.start, self.times_out = list(pages), start, times_out
        self.partial_output = partial_output
        self.calls: list[list[str]] = []

    @staticmethod
    def _write_output(handle: object, content: object) -> None:
        if content is None:
            return
        data = content if isinstance(content, bytes) else str(content).encode("utf-8")
        handle.write(data)
        handle.flush()

    def __call__(self, argv: list[str], **kwargs: object) -> subprocess.CompletedProcess[bytes]:
        timeout = kwargs.get("timeout")
        if not isinstance(timeout, (int, float)) or not 0 < timeout <= 600:
            raise AssertionError(f"external command is not bounded: {argv}")
        stdout_handle, stderr_handle = kwargs.get("stdout"), kwargs.get("stderr")
        if (
            kwargs.get("capture_output")
            or kwargs.get("shell") is not False
            or stdout_handle is subprocess.PIPE
            or stderr_handle is subprocess.PIPE
            or not hasattr(stdout_handle, "write")
            or not hasattr(stdout_handle, "fileno")
            or not hasattr(stderr_handle, "write")
            or not hasattr(stderr_handle, "fileno")
        ):
            raise AssertionError(f"external command must capture output via temporary files: {argv}")
        self.calls.append(argv)
        if self.times_out in argv:
            stdout, stderr = self.partial_output
            self._write_output(stdout_handle, stdout)
            self._write_output(stderr_handle, stderr)
            raise subprocess.TimeoutExpired(argv, timeout)
        full = "--full" in argv
        if "worker-list" in argv:
            result = self.pages.pop(0)
            complete = not result.get("partialHostErrors")
            body = {"ok": True, "result": result}
            concise = {"ok": complete, "result": {
                "workers": [{"dispatchId": row["dispatchId"], "state": row["workerState"],
                             "liveness": row["projection"]["liveness"]["verdict"]}
                            for row in result["workers"]],
                "scope": result["scope"],
                **({"nextCursor": result["page"]["nextCursor"]} if result["page"]["hasMore"] else {}),
            }}
            returncode = 0 if full or complete else 1
        elif "worker-start" in argv and self.start is not None:
            body, receipt = self.start, self.start.get("result")
            returncode = 0 if receipt and receipt["state"] == "ready" else 1
            concise = body if receipt is None else {"ok": returncode == 0, "result": {
                "dispatchId": receipt["dispatchId"], "taskId": receipt["taskId"],
                "runId": receipt["runId"], "state": receipt["state"],
                "agent": receipt["launch"]["requested"]["agent"],
                "model": receipt["launch"]["requested"]["model"],
            }}
        else:
            raise AssertionError(f"unexpected external command: {argv}")
        stdout = full_json(body) if full else json.dumps(concise, ensure_ascii=False) + "\n"
        self._write_output(stdout_handle, stdout)
        return subprocess.CompletedProcess(argv, returncode)


def run_main(cli: FakeOrcaCli, state_dir: Path, spec_path: Path, *extra: str) -> tuple[int, dict]:
    output = StringIO()
    with mock.patch.dict(os.environ, LOCAL_ENV):
        with mock.patch.object(router, "resolve_orca_command", return_value=["orca-test"]):
            with mock.patch.object(router, "resolve_agy_executable", return_value="agy-test"):
                with mock.patch.object(router.subprocess, "run", cli):
                    with redirect_stdout(output):
                        exit_code = router.main([
                            "--tier", "simple", "--run", RUN_ID, "--spec-file", str(spec_path),
                            "--state-dir", str(state_dir), *extra,
                        ])
    return exit_code, json.loads(output.getvalue())


class PolicyTests(unittest.TestCase):
    def test_example_profiles_are_explicit_allowlist_and_flash_is_denied_by_policy(self) -> None:
        router.validate_policy(EXAMPLE_POLICY)
        provider, profile = router.resolve_model(EXAMPLE_POLICY, "simple", "codex", "gpt-6-luna")
        self.assertEqual((provider, profile["model"]), ("codex", "gpt-6-luna"))
        with self.assertRaises(router.GuardError) as denied:
            router.resolve_model(EXAMPLE_POLICY, "simple", "agy", "gemini-flash-test")
        self.assertEqual(denied.exception.code, "model_denied")
        with self.assertRaises(router.GuardError) as missing:
            router.resolve_model(EXAMPLE_POLICY, "simple", "codex", "unlisted-model")
        self.assertEqual(missing.exception.code, "model_not_approved")

    def test_duplicate_model_name_requires_explicit_provider(self) -> None:
        policy = copy.deepcopy(EXAMPLE_POLICY)
        policy["providers"]["claude"]["profiles"]["simple"]["model"] = "gpt-6-luna"
        with self.assertRaises(router.GuardError) as raised:
            router.resolve_model(policy, "simple", "auto", "gpt-6-luna")
        self.assertEqual(raised.exception.code, "model_provider_required")
        provider, _ = router.resolve_model(policy, "simple", "claude", "gpt-6-luna")
        self.assertEqual(provider, "claude")

    def test_provider_ids_and_count_keys_come_from_policy(self) -> None:
        policy = generic_policy()
        router.validate_policy(policy)
        provider, profile = router.resolve_model(policy, "simple", "alpha", "alpha-model")
        self.assertEqual((provider, profile["model"]), ("alpha", "alpha-model"))
        with self.assertRaises(router.GuardError) as denied:
            router.resolve_model(policy, "simple", "alpha", "blocked-model")
        self.assertEqual(denied.exception.code, "model_denied")

        events = [
            {"time": timestamp(NOW - dt.timedelta(hours=1)), "provider": "alpha", "outcome": "success"},
            {"time": timestamp(NOW - dt.timedelta(hours=1)), "provider": "beta", "outcome": "unknown"},
            {"time": timestamp(NOW - dt.timedelta(hours=1)), "provider": "codex", "outcome": "success"},
        ]
        self.assertEqual(router.recent_counts(events, NOW, 7, set(policy["providers"])),
                         {"alpha": 1, "beta": 1})


class QuotaTests(unittest.TestCase):
    def test_snapshot_schema_uses_policy_pool_fields_and_provenance(self) -> None:
        router.validate_policy(EXAMPLE_POLICY)
        router.validate_quota_snapshot(EXAMPLE_SNAPSHOT, EXAMPLE_POLICY)

        policy = copy.deepcopy(EXAMPLE_POLICY)
        policy["quota_pools"]["codex-subscription"]["fields"]["operator_note"] = "string"
        snapshot = copy.deepcopy(EXAMPLE_SNAPSHOT)
        snapshot["pools"]["codex-subscription"]["operator_note"] = "checked manually"
        router.validate_quota_snapshot(snapshot, policy)

        snapshot["pools"]["codex-subscription"]["five_hour_used_pct"] = 50
        with self.assertRaises(router.GuardError) as raised:
            router.validate_quota_snapshot(snapshot, policy)
        self.assertEqual(raised.exception.code, "quota_invalid")
        self.assertEqual(raised.exception.details["missing_provenance"], ["observed_at", "source"])

    def test_fresh_snapshot_prefers_larger_remaining_quota(self) -> None:
        updates: dict[str, dict[str, object]] = {}
        for provider, used in (("codex", 70), ("claude", 50), ("agy", 10)):
            updates.update(pool_update(
                EXAMPLE_POLICY, provider,
                five_hour_used_pct=used,
                weekly_used_pct=used,
                five_hour_resets_at=NOW + dt.timedelta(hours=2),
                weekly_resets_at=NOW + dt.timedelta(days=2),
            ))
        quota = snapshot_for(EXAMPLE_POLICY, updates)
        router.validate_quota_snapshot(quota, EXAMPLE_POLICY)
        route = router.choose_route(EXAMPLE_POLICY, quota, [], "simple", "auto", None, NOW)
        self.assertEqual(route["provider"], "agy")
        self.assertEqual(route["selection_reason"], "quota_snapshot")

    def test_stale_and_unknown_snapshots_balance_by_recent_dispatch_count(self) -> None:
        stale_updates: dict[str, dict[str, object]] = {}
        for provider, used in (("codex", 10), ("claude", 20), ("agy", 30)):
            stale_updates.update(pool_update(
                EXAMPLE_POLICY, provider,
                observed_at=NOW - dt.timedelta(hours=2),
                five_hour_used_pct=used,
                weekly_used_pct=used,
                five_hour_resets_at=NOW + dt.timedelta(hours=2),
                weekly_resets_at=NOW + dt.timedelta(days=2),
            ))
        events = [
            {"time": timestamp(NOW - dt.timedelta(hours=1)), "provider": "codex", "outcome": "success"},
            {"time": timestamp(NOW - dt.timedelta(hours=1)), "provider": "agy", "outcome": "unknown"},
            {"time": timestamp(NOW - dt.timedelta(hours=1)), "provider": "agy", "outcome": "success"},
        ]
        stale_route = router.choose_route(EXAMPLE_POLICY, snapshot_for(EXAMPLE_POLICY, stale_updates),
                                          events, "simple", "auto", None, NOW)
        self.assertEqual(stale_route["provider"], "claude")
        self.assertEqual(stale_route["selection_reason"], "quota_unknown")

        unknown_route = router.choose_route(EXAMPLE_POLICY, snapshot_for(EXAMPLE_POLICY),
                                            events, "simple", "auto", None, NOW)
        self.assertEqual(unknown_route["provider"], "claude")
        self.assertEqual(unknown_route["selection_reason"], "quota_unknown")

    def test_cooldown_and_known_exhausted_pools_are_skipped(self) -> None:
        updates: dict[str, dict[str, object]] = {}
        updates.update(pool_update(
            EXAMPLE_POLICY, "codex", cooldown_until=NOW + dt.timedelta(minutes=20),
        ))
        updates.update(pool_update(
            EXAMPLE_POLICY, "claude", five_hour_used_pct=100, weekly_used_pct=100,
            five_hour_resets_at=NOW + dt.timedelta(hours=2),
            weekly_resets_at=NOW + dt.timedelta(days=2),
        ))
        route = router.choose_route(EXAMPLE_POLICY, snapshot_for(EXAMPLE_POLICY, updates),
                                    [], "simple", "auto", None, NOW)
        self.assertEqual(route["provider"], "agy")

    def test_stale_exhausted_snapshot_with_unknown_reset_is_unknown(self) -> None:
        quota = snapshot_for(EXAMPLE_POLICY, pool_update(
            EXAMPLE_POLICY, "codex", observed_at=NOW - dt.timedelta(hours=2),
            five_hour_used_pct=100, weekly_used_pct=100,
        ))
        status = router.pool_status(quota["pools"]["codex-subscription"], NOW, 60)
        self.assertFalse(status["depleted"])
        self.assertFalse(status["fresh_comparable"])


class SpecAndLivenessTests(unittest.TestCase):
    def test_bom_task_spec_and_non_ascii_arguments_are_preserved(self) -> None:
        spec_text = (
            "Target: 檔案路徑\n"
            "Change: 保留雙引號 \"與單引號\"\n"
            "Constraints: 不啟動模型\n"
            "Ownership: examples/orchestration-routing\n"
            "Observable acceptance: argv 保留中文與引號\n"
        )
        with tempfile.TemporaryDirectory() as temp_dir:
            spec_path = Path(temp_dir) / "task spec.md"
            spec_path.write_bytes(b"\xef\xbb\xbf" + spec_text.encode("utf-8"))
            spec = router.read_spec(str(spec_path), dry_run=False)

        self.assertEqual(spec, spec_text)
        plan = router.choose_route(EXAMPLE_POLICY, {"pools": {}}, [], "simple", "codex", None, NOW)
        argv = router.build_worker_start_argv(["orca"], plan, router.wrap_task_spec(spec), "current", "run id")
        self.assertIn("保留雙引號 \"與單引號\"", argv[argv.index("--spec") + 1])
        self.assertEqual(argv[argv.index("--run") + 1], "run id")
        self.assertIn("--model", argv)

    def test_liveness_reads_every_remote_page_in_the_same_run(self) -> None:
        cli = FakeOrcaCli([
            worker_page([worker_row("d1", "live")], next_cursor="cursor-2"),
            worker_page([worker_row("d2", "exited")]),
        ])
        with mock.patch.object(router.subprocess, "run", cli):
            result = router.list_worker_liveness(["orca"], RUN_ID, 3)
        self.assertEqual(result, {"live_workers": 1, "rows_checked": 2, "pages": 2})
        for argv in cli.calls:
            self.assertIn("--include-remote", argv)
            self.assertEqual(argv[argv.index("--run") + 1], RUN_ID)
        self.assertEqual(cli.calls[1][cli.calls[1].index("--cursor") + 1], "cursor-2")

    def test_liveness_rejects_repeated_pagination_cursors_before_launch(self) -> None:
        cases = (
            ("immediate-repeat", ("cursor-1", "cursor-1")),
            ("long-cycle", ("cursor-1", "cursor-2", "cursor-1")),
        )
        with tempfile.TemporaryDirectory() as temp_dir:
            spec_path = Path(temp_dir) / "task.md"
            spec_path.write_text(SPEC_TEXT, encoding="utf-8")
            for label, cursors in cases:
                with self.subTest(case=label):
                    state_dir = Path(temp_dir) / f"state-{label}"
                    cli = FakeOrcaCli([worker_page([], next_cursor=cursor) for cursor in cursors])
                    exit_code, response = run_main(cli, state_dir, spec_path, "--provider", "codex")

                    self.assertEqual(exit_code, 2)
                    self.assertFalse(response["ok"])
                    self.assertEqual(response["error"]["code"], "worker_list_unverifiable")
                    self.assertEqual(len(cli.calls), len(cursors))
                    self.assertTrue(all("worker-list" in argv for argv in cli.calls))
                    self.assertFalse(any("worker-start" in argv for argv in cli.calls))
                    self.assertFalse(state_dir.exists())

    def test_liveness_enforces_configured_limit_and_unknown_is_not_dead(self) -> None:
        at_limit = worker_page([worker_row(f"d{i}", "live") for i in range(3)])
        with mock.patch.object(router.subprocess, "run", FakeOrcaCli([at_limit])):
            with self.assertRaises(router.GuardError) as raised:
                router.list_worker_liveness(["orca"], RUN_ID, 3)
        self.assertEqual(raised.exception.code, "worker_limit_reached")

        unknown = worker_page([worker_row("d?", "unknown")])
        with mock.patch.object(router.subprocess, "run", FakeOrcaCli([unknown])):
            with self.assertRaises(router.GuardError) as unknown_error:
                router.list_worker_liveness(["orca"], RUN_ID, 3)
        self.assertEqual(unknown_error.exception.code, "worker_liveness_unknown")


class ReceiptTests(unittest.TestCase):
    def test_ready_unknown_and_null_dispatch_receipts_are_classified_safely(self) -> None:
        plan = router.choose_route(EXAMPLE_POLICY, {"pools": {}}, [], "simple", "codex", None, NOW)
        ready = {"ok": True, "result": {
            "state": "ready",
            "dispatchId": "dispatch-ready",
            "launch": {
                "requested": {"agent": "codex", "model": "gpt-6-luna"},
                "effective": {"agent": "codex", "model": "gpt-6-luna"},
            },
        }}
        verification = router.verify_launch(ready, plan)
        self.assertEqual(verification["status"], "confirmed")
        self.assertEqual(router.classify_worker_start_outcome(ready, None, 0, verification), "success")

        unknown = {"ok": True, "result": {"state": "unknown", "dispatchId": "dispatch-unknown"}}
        self.assertEqual(router.classify_worker_start_outcome(
            unknown, None, 0, {"status": "unconfirmed"}), "unknown")

        failed_without_dispatch = {"ok": False, "result": {"state": "failed", "dispatchId": None}}
        self.assertFalse(router.has_possible_created_resource(failed_without_dispatch))
        self.assertEqual(router.classify_worker_start_outcome(
            failed_without_dispatch, None, 1, {"status": "unconfirmed"}), "failed")

    def test_dry_run_is_offline_and_does_not_create_state(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            state_dir = Path(temp_dir) / "unused-state"
            output = StringIO()
            with mock.patch.dict(os.environ, LOCAL_ENV):
                with mock.patch.object(router.subprocess, "run", side_effect=AssertionError("dry-run invoked external CLI")):
                    with redirect_stdout(output):
                        exit_code = router.main([
                            "--tier", "simple", "--provider", "codex", "--dry-run",
                            "--quota-file", str(SNAPSHOT_PATH), "--state-dir", str(state_dir),
                        ])
            result = json.loads(output.getvalue())
            self.assertEqual(exit_code, 0)
            self.assertTrue(result["dry_run"])
            self.assertFalse(result["state_written"])
            self.assertFalse(state_dir.exists())

    def test_remote_environment_and_prefix_flags_are_refused(self) -> None:
        with mock.patch.dict(os.environ, {"ORCA_ENVIRONMENT": "remote-host", "ORCA_PAIRING_CODE": "", "ORCA_REMOTE_PAIRING": "", "ORCA_CLI_COMMAND": ""}):
            with self.assertRaises(router.GuardError) as environment_error:
                router.validate_local_execution_context()
        self.assertEqual(environment_error.exception.code, "remote_context_unsupported")

        with mock.patch.dict(os.environ, {"ORCA_ENVIRONMENT": "", "ORCA_PAIRING_CODE": "present", "ORCA_REMOTE_PAIRING": "", "ORCA_CLI_COMMAND": ""}):
            with self.assertRaises(router.GuardError) as pairing_error:
                router.validate_local_execution_context()
        self.assertEqual(pairing_error.exception.code, "remote_context_unsupported")

        with mock.patch.dict(os.environ, {"ORCA_ENVIRONMENT": "", "ORCA_PAIRING_CODE": "", "ORCA_REMOTE_PAIRING": "", "ORCA_CLI_COMMAND": "orca --environment=remote-host"}):
            with self.assertRaises(router.GuardError) as prefix_error:
                router.validate_local_execution_context()
        self.assertEqual(prefix_error.exception.code, "remote_context_unsupported")

        with mock.patch.dict(os.environ, {"ORCA_ENVIRONMENT": "", "ORCA_PAIRING_CODE": "", "ORCA_REMOTE_PAIRING": "present", "ORCA_CLI_COMMAND": ""}):
            with self.assertRaises(router.GuardError) as legacy_pairing_error:
                router.validate_local_execution_context()
        self.assertEqual(legacy_pairing_error.exception.code, "remote_context_unsupported")

    def test_mocked_launch_preserves_full_ready_unknown_and_failed_receipts(self) -> None:
        spec_text = (
            "Target: 本機 workspace\n"
            "Change: 保留 \"quoted 中文\"\n"
            "Constraints: 不重試\n"
            "Ownership: examples/orchestration-routing\n"
            "Observable acceptance: receipt 原樣保留\n"
        )
        ready = start_receipt("ready", "dispatch-ready", extra={"opaque": "full receipt data"})
        unknown = start_receipt("outcome_unknown", "dispatch-unknown", effective=False,
                                failedStage="agent_ready", lastError="turn not observed")
        failed = {"ok": False, "error": {"code": "agent_unconfigured", "message": "no resource created"}}
        unknown_without_dispatch = {
            "ok": False,
            "error": {
                "code": "runtime_timeout",
                "message": "The orchestration mutation may already have taken effect; do not assume it failed.",
                "data": {
                    "orchestrationRequestId": "req-mutation-1",
                    "recovery": {
                        "orchestrationRequestId": "req-mutation-1",
                        "queryCommand": [
                            "orca", "orchestration", "request-show", "--request", "req-mutation-1", "--json",
                        ],
                        "retryCommand": [
                            "orca", "orchestration", "worker-start", "--retry-request", "req-mutation-1",
                        ],
                        "recoveryBlocked": False,
                        "disposition": "outcome_unknown",
                        "workerDeathInferred": False,
                    },
                },
            },
        }
        cases = (
            ("ready", ready, 0, "success", "dispatch-ready"),
            ("unknown-dispatch", unknown, 3, "unknown", "dispatch-unknown"),
            ("unknown-no-dispatch", unknown_without_dispatch, 3, "unknown", None),
            ("failed", failed, 1, "failed", None),
        )

        with tempfile.TemporaryDirectory() as temp_dir:
            spec_path = Path(temp_dir) / "task spec.md"
            spec_path.write_bytes(b"\xef\xbb\xbf" + spec_text.encode("utf-8"))
            for label, start, expected_exit, expected_outcome, expected_dispatch in cases:
                with self.subTest(case=label):
                    state_dir = Path(temp_dir) / f"state-{label}"
                    cli = FakeOrcaCli([worker_page([])], start=start)
                    exit_code, response = run_main(cli, state_dir, spec_path, "--provider", "codex")
                    self.assertEqual((exit_code, response["outcome"]), (expected_exit, expected_outcome))
                    self.assertEqual(response["receipt"], json.loads(full_json(start)))
                    self.assertEqual(response["retry_attempts"], 0)
                    self.assertEqual(len(cli.calls), 2)
                    spec_argument = cli.calls[1][cli.calls[1].index("--spec") + 1]
                    self.assertIn("Observable acceptance: receipt", spec_argument)
                    self.assertIn("quoted 中文", spec_argument)
                    state_path = state_dir / "routing-state.json"
                    self.assertEqual(state_path.is_file(), expected_outcome != "failed")
                    if expected_outcome != "failed":
                        events = json.loads(state_path.read_text(encoding="utf-8"))["events"]
                        self.assertEqual(
                            [(event["outcome"], event["dispatch"], event["run"]) for event in events],
                            [(expected_outcome, expected_dispatch, RUN_ID)],
                        )
                    if expected_outcome == "success":
                        self.assertIn("full receipt data", response["raw_stdout"])
                    if expected_outcome == "unknown":
                        self.assertIn("do not retry", response["coordinator_action"])

    def test_custom_policy_file_controls_provider_ids_and_worker_limit(self) -> None:
        policy = generic_policy()
        policy["max_live_workers"] = 2
        spec_text = (
            "Target: custom provider\n"
            "Change: test configured maximum\n"
            "Constraints: no inference\n"
            "Ownership: temporary fixture\n"
            "Observable acceptance: custom limit blocks start\n"
        )

        with tempfile.TemporaryDirectory() as temp_dir:
            policy_path = Path(temp_dir) / "custom-policy.json"
            policy_path.write_text(json.dumps(policy), encoding="utf-8")
            spec_path = Path(temp_dir) / "task.md"
            spec_path.write_text(spec_text, encoding="utf-8")
            cli = FakeOrcaCli([worker_page([worker_row(f"d{i}", "live") for i in range(2)])])
            exit_code, response = run_main(cli, Path(temp_dir) / "state", spec_path,
                                           "--provider", "alpha", "--policy-file", str(policy_path))
            self.assertEqual(exit_code, 2)
            self.assertEqual(response["error"]["code"], "worker_limit_reached")
            self.assertEqual(response["error"]["details"]["max_live_workers"], 2)
            self.assertEqual(response["error"]["details"]["live_workers"], 2)
            self.assertEqual(len(cli.calls), 1)
            self.assertIn("--include-remote", cli.calls[0])
            self.assertEqual(cli.calls[0][cli.calls[0].index("--run") + 1], RUN_ID)

    def test_incomplete_inventory_and_read_only_timeouts_refuse_before_start(self) -> None:
        partial_hosts = worker_page([], partialHostErrors=[{
            "environmentId": "environment_windows", "name": "Windows host",
            "code": "host_unavailable", "dispatchIds": ["ctx_remote"],
        }])
        cases = (
            ("worker_inventory_incomplete", "codex", FakeOrcaCli([partial_hosts])),
            ("worker_list_timeout", "codex", FakeOrcaCli([], times_out="worker-list")),
            ("agy_models_timeout", "agy", FakeOrcaCli([], times_out="models")),
        )
        with tempfile.TemporaryDirectory() as temp_dir:
            spec_path = Path(temp_dir) / "task.md"
            spec_path.write_text(SPEC_TEXT, encoding="utf-8")
            for code, provider, cli in cases:
                with self.subTest(code=code):
                    state_dir = Path(temp_dir) / code
                    exit_code, response = run_main(cli, state_dir, spec_path, "--provider", provider)
                    self.assertEqual((exit_code, response["error"]["code"]), (2, code))
                    self.assertEqual(len(cli.calls), 1)
                    self.assertNotIn("worker-start", cli.calls[0])
                    self.assertFalse(state_dir.exists())
                    if code.endswith("_timeout"):
                        self.assertEqual(response["error"]["details"]["timeout_seconds"],
                                         router.READ_ONLY_TIMEOUT_SECONDS)

    def test_worker_start_timeout_is_unknown_keeps_partial_output_and_never_retries(self) -> None:
        ready_text = full_json(start_receipt("ready", "dispatch-late", warning="工作已輸入"))
        waiting = "仍在等待 worker…\n"
        cases = (
            ("posix-bytes", ready_text.encode("utf-8"), waiting.encode("utf-8"), "dispatch-late"),
            ("windows-text", ready_text, waiting, "dispatch-late"),
            ("no-output", None, None, None),
        )
        with tempfile.TemporaryDirectory() as temp_dir:
            spec_path = Path(temp_dir) / "task.md"
            spec_path.write_text(SPEC_TEXT, encoding="utf-8")
            for name, stdout, stderr, dispatch_id in cases:
                with self.subTest(name):
                    state_dir = Path(temp_dir) / name
                    cli = FakeOrcaCli([worker_page([])], times_out="worker-start",
                                      partial_output=(stdout, stderr))
                    exit_code, response = run_main(cli, state_dir, spec_path, "--provider", "codex")
                    self.assertEqual((exit_code, response["outcome"], response["ok"]), (3, "unknown", False))
                    self.assertEqual(response["timed_out_after_seconds"], router.WORKER_START_TIMEOUT_SECONDS)
                    self.assertIsNone(response["returncode"])
                    self.assertEqual(response["raw_stdout"], ready_text if stdout else "")
                    self.assertEqual(response["raw_stderr"], waiting if stderr else "")
                    self.assertIn("do not retry", response["coordinator_action"])
                    self.assertEqual(sum("worker-start" in argv for argv in cli.calls), 1)
                    events = json.loads((state_dir / "routing-state.json").read_text(encoding="utf-8"))["events"]
                    self.assertEqual([(event["outcome"], event["dispatch"], event["run"]) for event in events],
                                     [("unknown", dispatch_id, RUN_ID)])


if __name__ == "__main__":
    unittest.main()
