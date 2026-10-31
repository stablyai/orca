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


def receipt_process(argv: list[str], payload: dict, returncode: int = 0) -> subprocess.CompletedProcess[str]:
    return subprocess.CompletedProcess(
        argv, returncode, json.dumps(payload, ensure_ascii=False) + "\n", "mock stderr\n",
    )


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
        pages = [
            {"ok": True, "result": {
                "workers": [{"dispatchId": "d1", "projection": {"liveness": {"verdict": "live"}}}],
                "page": {"hasMore": True, "nextCursor": "cursor-2"},
            }},
            {"ok": True, "result": {
                "workers": [{"dispatchId": "d2", "projection": {"liveness": {"verdict": "exited"}}}],
                "page": {"hasMore": False},
            }},
        ]
        calls: list[list[str]] = []

        def invoke(argv: list[str]) -> subprocess.CompletedProcess[str]:
            calls.append(argv)
            return receipt_process(argv, pages[len(calls) - 1])

        with mock.patch.object(router, "invoke", side_effect=invoke):
            result = router.list_worker_liveness(["orca"], "bound-run", 3)
        self.assertEqual(result["pages"], 2)
        self.assertEqual(result["live_workers"], 1)
        for argv in calls:
            self.assertIn("--include-remote", argv)
            self.assertEqual(argv[argv.index("--run") + 1], "bound-run")
        self.assertEqual(calls[1][calls[1].index("--cursor") + 1], "cursor-2")

    def test_liveness_enforces_configured_limit_and_unknown_is_not_dead(self) -> None:
        rows = [{"dispatchId": f"d{i}", "projection": {"liveness": {"verdict": "live"}}}
                for i in range(3)]
        at_limit = {"ok": True, "result": {"workers": rows, "page": {"hasMore": False}}}
        with mock.patch.object(router, "invoke", return_value=receipt_process(["orca"], at_limit)):
            with self.assertRaises(router.GuardError) as raised:
                router.list_worker_liveness(["orca"], "bound-run", 3)
        self.assertEqual(raised.exception.code, "worker_limit_reached")

        unknown = {"ok": True, "result": {
            "workers": [{"dispatchId": "d?", "projection": {"liveness": {"verdict": "unknown"}}}],
            "page": {"hasMore": False},
        }}
        with mock.patch.object(router, "invoke", return_value=receipt_process(["orca"], unknown)):
            with self.assertRaises(router.GuardError) as unknown_error:
                router.list_worker_liveness(["orca"], "bound-run", 3)
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
            with mock.patch.dict(os.environ, {"ORCA_ENVIRONMENT": "", "ORCA_PAIRING_CODE": "", "ORCA_REMOTE_PAIRING": "", "ORCA_CLI_COMMAND": ""}):
                with mock.patch.object(router, "invoke", side_effect=AssertionError("dry-run invoked external CLI")):
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
        ready = {"ok": True, "result": {
            "state": "ready", "dispatchId": "dispatch-ready", "taskId": "task-ready",
            "launch": {
                "requested": {"agent": "codex", "model": "gpt-6-luna"},
                "effective": {"agent": "codex", "model": "gpt-6-luna"},
            },
            "extra": {"opaque": "full receipt data"},
        }}
        unknown = {"ok": True, "result": {"state": "unknown", "dispatchId": "dispatch-unknown", "extra": "keep"}}
        failed = {"ok": False, "result": {"state": "failed", "dispatchId": None, "error": "no resource created"}}
        cases = ((ready, 0, "success"), (unknown, 0, "unknown"), (failed, 1, "failed"))

        with tempfile.TemporaryDirectory() as temp_dir:
            spec_path = Path(temp_dir) / "task spec.md"
            spec_path.write_bytes(b"\xef\xbb\xbf" + spec_text.encode("utf-8"))
            for receipt, returncode, expected_outcome in cases:
                with self.subTest(outcome=expected_outcome):
                    state_dir = Path(temp_dir) / f"state-{expected_outcome}"
                    captured = StringIO()
                    calls: list[list[str]] = []

                    def invoke(argv: list[str]) -> subprocess.CompletedProcess[str]:
                        calls.append(argv)
                        if "worker-list" in argv:
                            return receipt_process(argv, {"ok": True, "result": {
                                "workers": [], "page": {"hasMore": False},
                            }})
                        self.assertIn("Observable acceptance: receipt", argv[argv.index("--spec") + 1])
                        self.assertIn("quoted 中文", argv[argv.index("--spec") + 1])
                        return receipt_process(argv, receipt, returncode)

                    with mock.patch.dict(os.environ, {"ORCA_ENVIRONMENT": "", "ORCA_PAIRING_CODE": "", "ORCA_REMOTE_PAIRING": "", "ORCA_CLI_COMMAND": ""}):
                        with mock.patch.object(router, "resolve_orca_command", return_value=["orca-test"]):
                            with mock.patch.object(router, "invoke", side_effect=invoke):
                                with redirect_stdout(captured):
                                    exit_code = router.main([
                                        "--tier", "simple", "--provider", "codex", "--run", "prebound-run",
                                        "--spec-file", str(spec_path), "--state-dir", str(state_dir),
                                    ])
                    response = json.loads(captured.getvalue())
                    self.assertEqual(response["outcome"], expected_outcome)
                    self.assertEqual(response["receipt"], receipt)
                    self.assertEqual(response["retry_attempts"], 0)
                    self.assertEqual(len(calls), 2)
                    if expected_outcome == "success":
                        self.assertEqual(exit_code, 0)
                        self.assertIn("full receipt data", response["raw_stdout"])
                        self.assertTrue((state_dir / "routing-state.json").is_file())
                    elif expected_outcome == "unknown":
                        self.assertEqual(exit_code, 3)
                        self.assertIn("do not retry", response["coordinator_action"])
                        self.assertTrue((state_dir / "routing-state.json").is_file())
                    else:
                        self.assertEqual(exit_code, 1)
                        self.assertFalse((state_dir / "routing-state.json").exists())

    def test_custom_policy_file_controls_provider_ids_and_worker_limit(self) -> None:
        policy = generic_policy()
        policy["max_live_workers"] = 2
        rows = [{"dispatchId": f"d{i}", "projection": {"liveness": {"verdict": "live"}}}
                for i in range(2)]
        listing = {"ok": True, "result": {"workers": rows, "page": {"hasMore": False}}}
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
            output = StringIO()
            calls: list[list[str]] = []

            def invoke(argv: list[str]) -> subprocess.CompletedProcess[str]:
                calls.append(argv)
                return receipt_process(argv, listing)

            with mock.patch.dict(os.environ, {"ORCA_ENVIRONMENT": "", "ORCA_PAIRING_CODE": "", "ORCA_REMOTE_PAIRING": "", "ORCA_CLI_COMMAND": ""}):
                with mock.patch.object(router, "resolve_orca_command", return_value=["orca-test"]):
                    with mock.patch.object(router, "invoke", side_effect=invoke):
                        with redirect_stdout(output):
                            exit_code = router.main([
                                "--tier", "simple", "--provider", "alpha", "--run", "prebound-run",
                                "--policy-file", str(policy_path), "--spec-file", str(spec_path),
                                "--state-dir", str(Path(temp_dir) / "state"),
                            ])
            response = json.loads(output.getvalue())
            self.assertEqual(exit_code, 2)
            self.assertEqual(response["error"]["code"], "worker_limit_reached")
            self.assertEqual(response["error"]["details"]["max_live_workers"], 2)
            self.assertEqual(response["error"]["details"]["live_workers"], 2)
            self.assertEqual(len(calls), 1)
            self.assertIn("--include-remote", calls[0])
            self.assertEqual(calls[0][calls[0].index("--run") + 1], "prebound-run")


if __name__ == "__main__":
    unittest.main()
