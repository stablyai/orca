#!/usr/bin/env python3
"""Require native Windows control metadata in a fresh isolated provider process."""
import argparse
import os
from pathlib import Path
import sys


def main():
    if (sys.platform != "win32" or os.environ.get("GITHUB_ACTIONS") != "true"
            or os.environ.get("ORCA_COMPUTER_BENCH_ISOLATED") != "1"
            or os.environ.get("ORCA_BACKGROUND_LAUNCH") != "1"):
        raise SystemExit("discovery probe requires isolated Windows CI")
    import bench
    import obs_win as obs
    from trial_contract import SELECTORS, select_unique
    bench.obs = obs
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    args.target = "fixture"
    args.out = args.out.resolve()
    args.out.mkdir(parents=True)
    sources = args.out / "sources"
    evidence = {"source": bench.pin_source(args.source, sources / "candidate")}
    bench.write_json(args.out / "source.json", evidence)
    with (args.out / "engines.log").open("ab") as log:
        trial = bench.Trial(args, args.out / "trial", log)
        try:
            trial.launch()
            trial.prepare("targeted_type")
            engine = trial.engine("candidate", sources)
            elements = engine.snapshot()
            bench.write_json(args.out / "snapshot.json", engine.last_snapshot)
            field = select_unique(elements, SELECTORS["field"])
            button = select_unique(elements, SELECTORS["button"])
            select_unique(elements, SELECTORS["color"])
            if "SetValue" not in field.get("actions", []) or "Invoke" not in button.get("actions", []):
                raise AssertionError("native control action patterns were not discovered")
        finally:
            trial.close()
    print("confirmed native edit, button and combo box discovery in a fresh provider")


if __name__ == "__main__":
    main()
