"""Regressions for false success claims and unsafe trial reuse in the original benchmark."""
from pathlib import Path
import sys
import tempfile
import time
import unittest

from process_scope import ProcessScope
from trial_contract import (DECOY, DiscoveryError, MARKER, TASKS, acknowledged, completed,
                            initial_state, prepared, schedule, select_unique, summarize, verdict)


class TaskContractTests(unittest.TestCase):
    def test_reset_requires_current_command_on_current_fixture(self):
        state = {**initial_state("targeted_type"), "instance": "new", "pid": 19, "ack": "current"}
        self.assertTrue(prepared(state, "targeted_type", "new", 19, "current"))
        for key, value in (("ack", "previous"), ("instance", "old"), ("pid", 20),
                           ("logicalFocus", "field"), ("selLen", 1), ("top", 1), ("dropOpen", True),
                           ("submittedText", "old"), ("clickedColor", "Blue")):
            with self.subTest(key=key):
                self.assertFalse(prepared({**state, key: value}, "targeted_type", "new", 19, "current"))
        self.assertFalse(acknowledged(state, "new", 19, "previous"))
        for key in ("submittedText", "clickedColor"):
            without_payload = {name: value for name, value in state.items() if name != key}
            self.assertFalse(prepared(without_payload, "targeted_type", "new", 19, "current"))

    def test_selectors_never_substitute_another_control(self):
        selector = (r"button", r"\bincrement\b")
        desired = {"role": "button", "label": "Increment"}
        self.assertEqual(select_unique([{"role": "button", "label": "Delete"}, desired], selector), desired)
        for elements in ([{"role": "button", "label": "Delete"}],
                         [{"role": "pane", "label": "Increment"}], [desired, dict(desired)], []):
            with self.subTest(elements=elements), self.assertRaises(DiscoveryError):
                select_unique(elements, selector)

    def test_completion_requires_exact_raw_text_and_unchanged_decoy(self):
        final = {**initial_state("targeted_type"), "text": MARKER}
        self.assertTrue(completed(final, "targeted_type"))
        for text in ("q" + MARKER, MARKER + "q", "Orca qcafé Ω", ""):
            with self.subTest(text=text):
                self.assertFalse(completed({**final, "text": text}, "targeted_type"))
        self.assertFalse(completed({**final, "decoyText": DECOY + MARKER}, "targeted_type"))

    def test_exactly_once_actions_reject_intermediate_and_duplicate_effects(self):
        for task, key in (("choose_and_click", "count"), ("type_submit", "returns"), ("replace_submit", "returns")):
            final = {**initial_state(task), key: 1}
            if task == "choose_and_click":
                final["combo"] = "Blue"
                payload, correct, wrong = "clickedColor", "Blue", "Red"
            else:
                final["text"] = MARKER
                payload, correct, wrong = "submittedText", MARKER, ""
            final[payload] = correct
            self.assertTrue(completed(final, task))
            for value in (wrong, None):
                with self.subTest(task=task, payload=value):
                    self.assertFalse(completed({**final, payload: value}, task))
            self.assertFalse(completed({name: value for name, value in final.items() if name != payload}, task))
            for value in (0, 2):
                with self.subTest(task=task, value=value):
                    self.assertFalse(completed({**final, key: value}, task))
        for color in ("Red", "Blue"):
            self.assertTrue(completed({**initial_state("click_interference"), "count": 1,
                                       "clickedColor": color}, "click_interference"))

    def test_observed_completion_is_independent_of_api_errors(self):
        row = {"prepared": True, "task": "targeted_type", "api_errors": ["timeout"]}
        self.assertEqual(verdict(row, {**initial_state(row["task"]), "text": MARKER}), "completed")
        self.assertEqual(verdict(row, initial_state(row["task"])), "failed")
        self.assertEqual(verdict(row, None), "unobserved")
        self.assertEqual(verdict({**row, "prepared": False}, None), "invalid_setup")

    def test_invalid_setup_does_not_inflate_scored_completion(self):
        base = {"engine": "candidate", "task": "targeted_type", "profile": "background"}
        result = summarize([{**base, "verdict": "invalid_setup"},
                            {**base, "verdict": "failed", "discovery_error": "no field"},
                            {**base, "verdict": "unobserved"},
                            {**base, "verdict": "completed", "api_errors": ["late error"]}])[0]
        self.assertEqual((result["planned"], result["scored"], result["invalid"], result["completed"]), (4, 3, 1, 1))
        self.assertEqual((result["discovery_failures"], result["unobserved"], result["api_errors"]), (1, 1, 1))

    def test_partial_failures_cannot_make_task_latency_look_fast(self):
        base = {"engine": "candidate", "task": "type_submit", "profile": "background"}
        result = summarize([{**base, "verdict": "completed", "attempt_ms": 400, "action_read_ms": [100, 150]},
                            {**base, "verdict": "failed", "attempt_ms": 2, "action_read_ms": [1]},
                            {**base, "verdict": "unobserved", "attempt_ms": 30000}])[0]
        self.assertEqual(result["task_ms"], 400)
        self.assertEqual(result["action_read_ms"], 125)
        self.assertEqual((result["timed_completions"], result["timed_failures"]), (1, 2))
        self.assertEqual(result["failed_attempt_ms"], 15001)

    def test_engine_order_is_reproducible_and_rotates_each_round(self):
        cells = schedule(["baseline", "candidate", "cua"], TASKS, 3, 417)
        self.assertEqual(cells, schedule(["baseline", "candidate", "cua"], TASKS, 3, 417))
        self.assertEqual(len(cells), len(TASKS) * 9)
        for task in TASKS:
            positions = [[cell["engine"] for cell in cells if cell["task"] == task and cell["round"] == index]
                         for index in range(3)]
            for index in range(3):
                self.assertEqual({order[index] for order in positions}, {"baseline", "candidate", "cua"})

    def test_process_scope_stops_descendant_writes_before_returning(self):
        with tempfile.TemporaryDirectory() as directory:
            heartbeat = Path(directory) / "heartbeat"
            child = "import pathlib,time; p=pathlib.Path(" + repr(str(heartbeat)) + "); "
            child += "\nwhile True:\n p.write_text(str(time.monotonic())); time.sleep(0.02)"
            parent = "import subprocess,sys,time; subprocess.Popen([sys.executable,'-c'," + repr(child) + "]); time.sleep(60)"
            scope = ProcessScope(directory)
            try:
                proc = scope.spawn([sys.executable, "-c", parent], hidden=True)
                end = time.monotonic() + 10
                while not heartbeat.exists() and time.monotonic() < end:
                    time.sleep(0.01)
                self.assertTrue(heartbeat.exists(), "descendant never started")
                scope.close()
                self.assertIsNotNone(proc.poll())
                final = heartbeat.read_bytes()
                time.sleep(0.12)
                self.assertEqual(heartbeat.read_bytes(), final)
            finally:
                scope.close()


if __name__ == "__main__":
    unittest.main()
