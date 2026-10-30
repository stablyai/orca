#!/usr/bin/env python3
"""Require exact synthetic Unicode typing and preflight refusal on isolated X11."""
import argparse
import ctypes
from contextlib import nullcontext
import fcntl
import os
from pathlib import Path
import subprocess
import signal
import shutil
import sys
import time


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
        ("format", "a\u00a0\u200b\u200d\u00adb \U0001fae0", None),
        ("long", "éΩ" * 300, None),
        ("oversized", "éΩ" * 300 + "é", "limited to 600"),
        ("slots", "".join(chr(0x4E00 + i) for i in range(256)), "insufficient unused X11 keycodes"),
        ("identical", "café Ω", None),
        ("supplementary-selection", mixed, None),
        ("append", mixed, None),
        ("latin-layout", "Orca ASCII", None),
        ("busy", mixed, "another keyboard operation is active"),
    ]
    replacement = trial_contract.TASKS["replace_submit"]

    def keymap():
        return {flag: subprocess.check_output(["xmodmap", flag], text=True) for flag in ("-pke", "-pm")}

    def held_keys():
        obs.X.XQueryKeymap.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_char)]
        result = (ctypes.c_char * 32)()
        obs.X.XQueryKeymap(obs.main_display().d, result)
        return bytes(result)

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
            trial_contract.MARKER = "hello" + marker if name in ("append", "latin-layout") else marker
            task = "replace_submit"
            trial_contract.TASKS["replace_submit"] = replacement
            if name in ("identical", "supplementary-selection"):
                trial_contract.TASKS["replace_submit"] = replacement[:-1] + replacement[1:]
            if name in ("append", "latin-layout"):
                trial_contract.TASKS["replace_submit"] = [step for step in replacement if step[0] != "ctrl_a"]
            cell = {"engine": "candidate", "task": task, "profile": "foreground", "round": 0, "case": name}
            trial = TypingTrial(args, args.out / f"trial-{len(evidence['rows'])}", log)
            if name == "latin-layout":
                subprocess.run(["setxkbmap", "ru"], check=True)
            before = keymap()
            try:
                with (open(Path(os.environ["XDG_RUNTIME_DIR"]) / "orca-computer-keyboard.lock", "a")
                      if name == "busy" else nullcontext()) as lock:
                    if lock is not None:
                        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    row = trial.run(cell, sources)
                evidence["rows"].append(row)
                restored = keymap() == before
            finally:
                trial.close()
                if name == "latin-layout":
                    subprocess.run(["setxkbmap", "us"], check=True)
            bench.write_json(args.out / "results.json", evidence)
            if not restored:
                raise AssertionError("synthetic typing did not restore the X11 keyboard and modifier mappings")
            if (row["verdict"] in ("invalid_setup", "unobserved") or row.get("terminal_observation_error")
                    or row.get("observer_error")):
                raise AssertionError("typing observation failed")
            state = row["final_state"]
            if name == "supplementary-selection" and row["api_errors"]:
                if (len(row["api_errors"]) != 1 or "requires readable focused text" not in str(row["api_errors"])
                        or state["text"] != marker or state["returns"] != 0 or state["submittedText"] is not None
                        or state["decoyText"] != "untouched" or state["selStart"] != 0
                        or state["selLen"] != len(marker.encode("utf-16-le")) // 2
                        or row["steps"][-1]["action"] != "type" or row["steps"][-1]["result"].get("error") is not True):
                    raise AssertionError("ambiguous selection was not refused before typing")
            elif refusal:
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

        for mode in ("typing", "held-key"):
            trial = TypingTrial(args, args.out / ("cancelled-" + mode), log)
            try:
                trial.launch()
                trial.prepare("replace_submit")
                engine = trial.engine("candidate", sources)
                field = trial_contract.select_unique(engine.snapshot(), trial_contract.SELECTORS["field"])
                for action in ("click", "ctrl_a"):
                    if engine.act(action, field, True).get("error"):
                        raise AssertionError("cancellation fixture could not focus and select the field")
                before = keymap()
                operation = trial.directory / "cancel.json"
                bench.write_json(operation, engine._req("type_text", field, True, text="éΩAa" * 150))
                held_before = held_keys()
                env = dict(os.environ)
                ready = trial.directory / "held-ready"
                if mode == "held-key":
                    directory = trial.directory / "bin"
                    directory.mkdir()
                    stand_in = directory / "xdotool"
                    stand_in.write_text(
                        f"#!{sys.executable}\nimport subprocess, time\nfrom pathlib import Path\n"
                        f"subprocess.run([{shutil.which('xdotool')!r}, 'keydown', 'Shift_L'], check=True)\n"
                        f"Path({str(ready)!r}).touch()\ntime.sleep(60)\n"
                    )
                    stand_in.chmod(0o700)
                    env["PATH"] = str(directory) + os.pathsep + env["PATH"]
                process = trial.engines.spawn([sys.executable, engine.o.script, str(operation)],
                                              stdout=subprocess.PIPE, stderr=log, env=env)
                bench.wait_for(lambda: keymap() != before, 5)
                if mode == "held-key":
                    bench.wait_for(ready.exists, 5)
                    if held_keys() == held_before:
                        raise AssertionError("held-key cancellation control did not press a key")
                else:
                    bench.wait_for(lambda: trial.state()["text"] != "hello", 5)
                process.send_signal(signal.SIGTERM)
                process.communicate(timeout=3)
                if process.returncode != 143 or keymap() != before or held_keys() != held_before:
                    raise AssertionError("cancelled typing did not restore its owned mappings and release keys")
                time.sleep(0.4)
                first = trial.state()
                time.sleep(0.4)
                last = trial.state()
                if (first["text"] != last["text"] or last["returns"] != 0
                        or last["decoyText"] != "untouched"):
                    raise AssertionError("typing continued after the bridge was terminated")
                evidence.setdefault("cancelled", {})[mode] = {
                    "before": first, "after": last, "exit_code": process.returncode}
                bench.write_json(args.out / "results.json", evidence)
            finally:
                trial.close()


if __name__ == "__main__":
    main()
