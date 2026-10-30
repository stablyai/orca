#!/usr/bin/env python3
"""Require exact synthetic Unicode typing and preflight refusal on isolated X11."""
import argparse
import os
from pathlib import Path
import subprocess
import sys


def main():
    if (sys.platform != "linux" or os.environ.get("GITHUB_ACTIONS") != "true"
            or os.environ.get("ORCA_COMPUTER_BENCH_ISOLATED") != "1"
            or os.environ.get("ORCA_BACKGROUND_LAUNCH") != "1"):
        raise SystemExit("typing probe requires isolated Linux CI")
    import bench
    import obs_x11 as obs
    import trial_contract
    bench.obs = obs
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", required=True)
    parser.add_argument("--electron", required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    args.target = "electron"
    args.out = args.out.resolve()
    args.out.mkdir(parents=True)
    sources = args.out / "sources"
    evidence = {"source": bench.pin_source(args.source, sources / "candidate"), "rows": []}
    mixed = "- café Ω 漢字 🙂 e\u0301 ΩéΩé"
    cases = [("mixed", mixed, None)] * 3 + [
        ("long", "éΩ" * 300, None),
        ("oversized", "éΩ" * 300 + "é", "limited to 600"),
        ("slots", "".join(chr(0x4E00 + i) for i in range(256)), "insufficient unused X11 keycodes"),
        ("identical", mixed, None),
        ("append", mixed, None),
    ]
    replacement = trial_contract.TASKS["replace_submit"]

    def keymap():
        return {flag: subprocess.check_output(["xmodmap", flag], text=True) for flag in ("-pke", "-pm")}

    class TypingTrial(bench.Trial):
        def engine(self, name, sources):
            engine = super().engine(name, sources)

            def ready():
                elements = engine.snapshot()
                bench.write_json(self.directory / "readiness-snapshot.json", engine.last_snapshot)
                try:
                    trial_contract.select_unique(elements, trial_contract.SELECTORS["field"])
                except trial_contract.DiscoveryError:
                    return False
                return True

            bench.wait_for(ready, 10)
            return engine

    with (args.out / "engines.log").open("ab") as log:
        for name, marker, refusal in cases:
            bench.MARKER = marker
            trial_contract.MARKER = "hello" + marker if name == "append" else marker
            task = "replace_submit"
            trial_contract.TASKS["replace_submit"] = replacement
            if name == "identical":
                trial_contract.TASKS["replace_submit"] = replacement[:-1] + replacement[1:]
            if name == "append":
                trial_contract.TASKS["replace_submit"] = [step for step in replacement if step[0] != "ctrl_a"]
            cell = {"engine": "candidate", "task": task, "profile": "foreground", "round": 0, "case": name}
            trial = TypingTrial(args, args.out / f"trial-{len(evidence['rows'])}", log)
            before = keymap()
            try:
                row = trial.run(cell, sources)
                evidence["rows"].append(row)
            finally:
                trial.close()
            bench.write_json(args.out / "results.json", evidence)
            if keymap() != before:
                raise AssertionError("synthetic typing did not restore the X11 keyboard and modifier mappings")
            if (row["verdict"] in ("invalid_setup", "unobserved") or row.get("terminal_observation_error")
                    or row.get("observer_error")):
                raise AssertionError("typing observation failed")
            state = row["final_state"]
            if refusal:
                if (not row["api_errors"] or refusal not in str(row["api_errors"])
                        or state["text"] != "hello" or state["returns"] != 0
                        or state["submittedText"] is not None or state["decoyText"] != "untouched"):
                    raise AssertionError("unsupported synthetic typing mutated the fixture or was not refused")
            elif row["verdict"] != "completed" or row["api_errors"]:
                raise AssertionError("Unicode text was not submitted exactly once")
            elif any(step["result"].get("route") != "synthetic" for step in row["steps"] if step["action"] == "type"):
                raise AssertionError("typing probe did not exercise synthetic input")
            if row.get("observation", {}).get("clipboard_changed"):
                raise AssertionError("synthetic typing changed the clipboard")
            print(f"confirmed synthetic typing contract for {len(marker)} characters", flush=True)


if __name__ == "__main__":
    main()
