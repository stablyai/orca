#!/usr/bin/env python3
"""Record Linux restoration stages on a disposable Electron fixture."""
import argparse
import importlib.util
import os
from pathlib import Path
import sys
import time


def load_runtime(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    module.Atspi.set_timeout(800, 15000)
    return module


def main():
    if (sys.platform != "linux" or os.environ.get("GITHUB_ACTIONS") != "true"
            or os.environ.get("ORCA_COMPUTER_BENCH_ISOLATED") != "1"
            or os.environ.get("ORCA_BACKGROUND_LAUNCH") != "1"):
        raise SystemExit("focus probe requires isolated Linux CI")
    import bench
    import obs_x11 as obs
    bench.obs = obs
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--electron", required=True)
    parser.add_argument("--baseline", required=True)
    parser.add_argument("--candidate", required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    args.target = "electron"
    args.out = args.out.resolve()
    args.out.mkdir(parents=True)
    sources = args.out / "sources"
    evidence = {"sources": {name: bench.pin_source(sha, sources / name) for name, sha in
                            (("baseline", args.baseline), ("candidate", args.candidate))}, "trials": []}
    baseline = load_runtime(sources / "baseline/native/computer-use-linux/runtime.py", "focus_baseline")
    candidate = load_runtime(sources / "candidate/native/computer-use-linux/runtime.py", "focus_candidate")
    with (args.out / "probe.log").open("ab") as log:
        for mode in ("one-window", "minimized", "two-windows"):
            sibling = mode == "two-windows"
            os.environ["BENCH_FOCUS_SIBLING"] = "1" if sibling else "0"
            trial = bench.Trial(args, args.out / mode, log)
            row = {"mode": mode, "sibling": sibling}
            evidence["trials"].append(row)
            try:
                trial.launch()
                trial.target = trial.state()["nativeWindowId"]
                if not trial.target or obs.main_display().pid_of(trial.target) != trial.pid:
                    raise AssertionError("primary fixture native identity was not confirmed")
                def prepare():
                    trial.prepare("type_submit")
                    if mode == "minimized":
                        obs.xdotool("windowminimize", trial.target)
                        bench.wait_for(lambda: (obs.main_display().prop_longs(trial.target, "WM_STATE") or [0])[0] == 3)
                prepare()
                app = bench.wait_for(lambda: baseline.attempt(lambda: baseline.find_app(f"pid:{trial.pid}")))
                if sibling:
                    bench.wait_for(lambda: len(baseline.windows_for(app)) == 2)
                matches = [(i, w) for i, w in baseline.windows_for(app) if baseline.name_of(w) == "BenchElectron"]
                if len(matches) != 1:
                    raise AssertionError("fixture accessibility window is missing or ambiguous")
                index, window = matches[0]
                row.update({"pid": trial.pid, "fixture_window": trial.target, "atspi_index": index,
                            "atspi_windows": [i for i, _ in baseline.windows_for(app)],
                            "native_ids": obs.xdotool("search", "--pid", trial.pid).stdout.split()})
                row["managed_ids"] = [value for value in row["native_ids"]
                                      if int(value) in obs.main_display().stacking()]

                def trace():
                    return {"selected_active": baseline.has_state(window, baseline.Atspi.StateType.ACTIVE),
                            "native_active": obs.main_display().active(), "fixture_state": trial.state()}

                row["before"] = trace()
                try:
                    row["grab_focus"] = bool(baseline.Atspi.Component.grab_focus(window.get_component_iface()))
                except Exception as error:
                    row["grab_focus_error"] = repr(error)
                row["after_grab"] = []
                for _ in range(11):
                    row["after_grab"].append(trace())
                    time.sleep(0.05)
                if not row["after_grab"][-1]["selected_active"]:
                    try:
                        result = obs.xdotool("search", "--pid", trial.pid, "windowactivate", "--sync")
                        row["manual_legacy_fallback"] = {"status": result.returncode, "stderr": result.stderr}
                    except Exception as error:
                        row["manual_legacy_fallback"] = {"error": repr(error)}
                    time.sleep(0.5)
                    row["after_legacy"] = trace()
                prepare()
                ids = row["managed_ids"]
                if not sibling and len(ids) == 1:
                    result = obs.xdotool("windowactivate", "--sync", ids[0])
                    time.sleep(0.5)
                    row["explicit_fallback"] = {"status": result.returncode, "after": trace()}
                prepare()
                row["candidate_before"] = trace()
                candidate_app = candidate.find_app(f"pid:{trial.pid}")
                _, candidate_window = candidate.choose_window(candidate_app, window_index=index)
                native_calls = []
                native_run = candidate.subprocess.run
                def observed_run(command, **kwargs):
                    native_calls.append(command)
                    return native_run(command, **kwargs)
                candidate.subprocess.run = observed_run
                try:
                    candidate.restore_window(candidate_app, candidate_window)
                finally:
                    candidate.subprocess.run = native_run
                row["candidate_native_calls"] = native_calls
                time.sleep(0.5)
                row["candidate_after"] = trace()
                if sibling:
                    if any("windowactivate" in command for command in native_calls):
                        raise AssertionError("ambiguous restoration used native activation")
                    if row["candidate_after"]["native_active"] not in (trial.target, trial.sentinel):
                        raise AssertionError("ambiguous restoration activated a sibling")
                    if (row["candidate_after"]["native_active"] == trial.target
                            and not row["candidate_after"]["selected_active"]):
                        raise AssertionError("native and accessibility focus disagree")
                elif not row["candidate_after"]["selected_active"]:
                    raise AssertionError("singleton restoration did not focus the selected window")
                row["passed"] = True
            except Exception as error:
                row["error"] = repr(error)
            finally:
                trial.close()
                bench.write_json(args.out / "results.json", evidence)
    return 0 if all(row.get("passed") for row in evidence["trials"]) else 1


if __name__ == "__main__":
    sys.exit(main())
