#!/usr/bin/env python3
"""Require exact synthetic Unicode typing and preflight refusal on isolated X11."""
import argparse
import os
from pathlib import Path
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
    markers = ("- café Ω 漢字 🙂 e\u0301 ΩéΩé", "éΩ" * 300, "éΩ" * 300 + "é")
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
        for marker in markers:
            bench.MARKER = trial_contract.MARKER = marker
            cell = {"engine": "candidate", "task": "replace_submit", "profile": "foreground", "round": 0}
            trial = TypingTrial(args, args.out / f"trial-{len(evidence['rows'])}", log)
            try:
                row = trial.run(cell, sources)
                evidence["rows"].append(row)
            finally:
                trial.close()
            bench.write_json(args.out / "results.json", evidence)
            if (row["verdict"] in ("invalid_setup", "unobserved") or row.get("terminal_observation_error")
                    or row.get("observer_error")):
                raise AssertionError("typing observation failed")
            state = row["final_state"]
            if len(marker) > 600:
                if (not row["api_errors"] or "limited to 600" not in str(row["api_errors"])
                        or state["text"] != "hello" or state["returns"] != 0
                        or state["submittedText"] is not None or state["decoyText"] != "untouched"):
                    raise AssertionError("oversized synthetic typing mutated the fixture or was not refused")
            elif row["verdict"] != "completed" or row["api_errors"]:
                raise AssertionError("Unicode text was not submitted exactly once")
            if row.get("observation", {}).get("clipboard_changed"):
                raise AssertionError("synthetic typing changed the clipboard")
            print(f"confirmed synthetic typing contract for {len(marker)} characters", flush=True)


if __name__ == "__main__":
    main()
