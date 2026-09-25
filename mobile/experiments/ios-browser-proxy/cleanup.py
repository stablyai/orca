"""Best-effort cleanup of only the simulator and process group acquired by this run."""
import json
import os
import signal
import sys
import time


def cleanup(artifacts, device, fixture, command, original_error=None):
    receipt = {"device": device, "fixturePid": fixture.pid if fixture else None,
               "originalError": repr(original_error) if original_error else None,
               "attempts": {}, "errors": []}

    def attempt(name, action):
        try:
            action()
            receipt["attempts"][name] = "succeeded"
            return True
        except Exception as error:
            # Each owned resource must get its cleanup attempt even if another fails.
            receipt["attempts"][name] = "failed"
            receipt["errors"].append({"step": name, "error": repr(error)})
            return False

    receipt["ownedSimulatorDeleted"] = False
    if device:
        attempt("shutdown", lambda: command("xcrun", "simctl", "shutdown", device, timeout=30))
        receipt["ownedSimulatorDeleted"] = attempt(
            "delete", lambda: command("xcrun", "simctl", "delete", device, timeout=30))

    receipt["fixtureGroupExited"] = fixture is None
    receipt["fixtureExited"] = fixture is None
    if fixture:
        def send(sig):
            try:
                os.killpg(fixture.pid, sig)
            except ProcessLookupError:
                pass  # An absent owned group is already cleaned up.

        def wait_group(seconds):
            deadline = time.monotonic() + seconds
            while True:
                fixture.poll()  # Reap the launcher before checking its descendants.
                try:
                    os.killpg(fixture.pid, 0)
                except ProcessLookupError:
                    return
                if time.monotonic() >= deadline:
                    raise TimeoutError("Owned fixture process group still exists")
                time.sleep(0.1)

        attempt("fixture-term", lambda: send(signal.SIGTERM))
        exited = attempt("fixture-term-wait", lambda: wait_group(10))
        if not exited:
            attempt("fixture-kill", lambda: send(signal.SIGKILL))
            exited = attempt("fixture-kill-wait", lambda: wait_group(5))
        receipt["fixtureGroupExited"] = exited
        receipt["fixtureExited"] = attempt("fixture-reap", lambda: fixture.wait(timeout=5))

    attempt("receipt", lambda: (artifacts / "cleanup.json").write_text(json.dumps(receipt, indent=2)))
    if receipt["errors"]:
        print("Cleanup evidence: " + json.dumps(receipt), file=sys.stderr)
        if original_error is None:
            raise RuntimeError("Cleanup failed; see cleanup.json and stderr")
    return receipt
