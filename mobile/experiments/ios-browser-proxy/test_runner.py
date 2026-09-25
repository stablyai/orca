"""Run with: ORCA_BACKGROUND_LAUNCH=1 python3 -m unittest discover -s mobile/experiments/ios-browser-proxy."""
import contextlib
import copy
import io
import json
from pathlib import Path
import signal
import subprocess
import tempfile
import unittest
from unittest.mock import Mock, patch

from cleanup import cleanup
from observations import validate


class CleanupTests(unittest.TestCase):
    def test_shutdown_failure_preserves_original_and_attempts_remaining_cleanup(self):
        original = RuntimeError("launch failed")
        fixture = Mock(pid=1234)
        calls = []

        def command(*args, **kwargs):
            calls.append(args[2])
            if args[2] == "shutdown":
                raise subprocess.CalledProcessError(1, args)

        with tempfile.TemporaryDirectory() as directory, patch("cleanup.os.killpg") as killpg:
            killpg.side_effect = [None, ProcessLookupError()]
            with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(RuntimeError) as caught:
                try:
                    raise original
                finally:
                    cleanup(Path(directory), "owned-device", fixture, command, original)
            self.assertIs(caught.exception, original)
            self.assertEqual(calls, ["shutdown", "delete"])
            killpg.assert_any_call(1234, signal.SIGTERM)
            fixture.wait.assert_called_once_with(timeout=5)
            receipt = json.loads((Path(directory) / "cleanup.json").read_text())
            self.assertTrue(receipt["ownedSimulatorDeleted"])
            self.assertTrue(receipt["fixtureGroupExited"])
            self.assertIn("launch failed", receipt["originalError"])
            self.assertEqual(receipt["errors"][0]["step"], "shutdown")

    def test_delete_and_termination_errors_still_kill_reap_and_write_receipt(self):
        fixture = Mock(pid=1234)
        with tempfile.TemporaryDirectory() as directory, patch("cleanup.os.killpg") as killpg, \
                patch("cleanup.time.monotonic", side_effect=[0, 11, 12]), \
                contextlib.redirect_stderr(io.StringIO()):
            killpg.side_effect = [PermissionError("term denied"), None, None, ProcessLookupError()]
            command = Mock(side_effect=[None, OSError("delete failed")])
            fixture.wait.side_effect = subprocess.TimeoutExpired("fixture", 5)
            with self.assertRaisesRegex(RuntimeError, "Cleanup failed"):
                cleanup(Path(directory), "owned-device", fixture, command)
            killpg.assert_any_call(1234, signal.SIGKILL)
            fixture.wait.assert_called_once_with(timeout=5)
            receipt = json.loads((Path(directory) / "cleanup.json").read_text())
            self.assertFalse(receipt["ownedSimulatorDeleted"])
            self.assertFalse(receipt["fixtureExited"])
            self.assertTrue(receipt["fixtureGroupExited"])
            self.assertEqual([error["step"] for error in receipt["errors"]],
                             ["delete", "fixture-term", "fixture-term-wait", "fixture-reap"])


class ObservationTests(unittest.TestCase):
    def setUp(self):
        evidence = [json.loads(line) for line in Path(__file__).with_name("evidence.jsonl").read_text().splitlines()]
        self.results = [{key: value for key, value in row.items() if key != "kind"}
                        for row in evidence if row["kind"] == "native"]
        self.network = [{key: value for key, value in row.items() if key != "kind"}
                        for row in evidence if row["kind"] == "network"]

    def test_expected_bypass_is_valid_measurement(self):
        validate(self.results, self.network)

    def test_broken_positive_or_missing_measurements_fail(self):
        for case, value in (("complete", False), ("content-blocker-compiled", False),
                            ("apis-A-localhost", {"fetch": "DIRECT-BYPASS"})):
            with self.subTest(case=case):
                results = copy.deepcopy(self.results)
                next(row for row in results if row["case"] == case)["value"] = value
                with self.assertRaises(ValueError):
                    validate(results, self.network)
        with self.assertRaises(ValueError):
            validate([row for row in self.results if row["case"] != "lifecycle-background"], self.network)

    def test_network_evidence_required_despite_image_error(self):
        with self.assertRaises(ValueError):
            validate(self.results, [row for row in self.network if row.get("path") != "/image?policy=1"])
        network = copy.deepcopy(self.network)
        next(row for row in network if row.get("path") == "/image?policy=1")["host"] = "127.0.0.1:1234"
        with self.assertRaises(ValueError):
            validate(self.results, network)

    def test_truncated_loss_capture_fails(self):
        cut = next(i for i, row in enumerate(self.network) if row.get("path") == "/listener-down")
        with self.assertRaisesRegex(ValueError, "traffic"):
            validate(self.results, self.network[:cut + 1])

    def test_missing_route_b_network_evidence_fails(self):
        with self.assertRaisesRegex(ValueError, "B localhost fetch traffic"):
            validate(self.results, [row for row in self.network if row.get("route") != "B"])

    def test_mapped_ipv6_garbage_event_types_fail(self):
        network = copy.deepcopy(self.network)
        for row in network:
            if row.get("host", "").startswith("[::ffff:7f00:1]:"):
                row["event"] = "garbage"
        with self.assertRaisesRegex(ValueError, "mapped bypass mechanisms"):
            validate(self.results, network)

    def test_false_lifecycle_observations_fail(self):
        results = copy.deepcopy(self.results)
        for row in results:
            if row["case"].startswith("lifecycle-"):
                row["value"] = False
        with self.assertRaisesRegex(ValueError, "lifecycle-ready"):
            validate(results, self.network)

    def test_boolean_observations_require_true(self):
        for case in ("complete", "content-blocker-compiled", "lifecycle-ready",
                     "lifecycle-background", "lifecycle-foreground"):
            for value in (False, 1, "true", None):
                with self.subTest(case=case, value=value):
                    results = copy.deepcopy(self.results)
                    next(row for row in results if row["case"] == case)["value"] = value
                    with self.assertRaisesRegex(ValueError, case):
                        validate(results, self.network)

    def test_each_post_loss_mechanism_requires_network_evidence(self):
        cut = next(i for i, row in enumerate(self.network) if row.get("path") == "/listener-down")
        for index, row in enumerate(self.network[cut + 1:], cut + 1):
            if row["event"] not in ("http", "websocket"):
                continue
            with self.subTest(event=row):
                with self.assertRaisesRegex(ValueError, "traffic"):
                    validate(self.results, self.network[:index] + self.network[index + 1:])
        with self.assertRaisesRegex(ValueError, "SOCKS attempt after tunnel loss"):
            validate(self.results, [row for row in self.network if not
                     (row.get("route") == "A" and row.get("tunnelDown") is True)])

    def test_route_b_before_loss_cannot_substitute_for_surviving_traffic(self):
        cut = next(i for i, row in enumerate(self.network) if row.get("path") == "/listener-down")
        network = self.network[:cut + 1] + [row for row in self.network[cut + 1:] if row.get("route") != "B"]
        with self.assertRaisesRegex(ValueError, "B localhost fetch traffic"):
            validate(self.results, network)

    def test_each_mapped_ipv6_mechanism_requires_its_event_type(self):
        for index, row in enumerate(self.network):
            if not row.get("host", "").startswith("[::ffff:7f00:1]:"):
                continue
            with self.subTest(event=row):
                network = copy.deepcopy(self.network)
                network[index]["event"] = "garbage"
                with self.assertRaisesRegex(ValueError, "mapped bypass mechanisms"):
                    validate(self.results, network)


if __name__ == "__main__":
    unittest.main()
