#!/usr/bin/env python3
"""Compare direct native providers on disposable, independently observed task fixtures."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import subprocess
import sys
import time
import uuid

from process_scope import ProcessScope
from trial_contract import (DiscoveryError, MARKER, SELECTORS, TASKS, acknowledged, prepared,
                            schedule, select_unique, summarize, verdict)

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[2]
WIN = sys.platform == "win32"


def read_json(path):
    try:
        return json.loads(Path(path).read_text(encoding="utf-8-sig"))
    except (OSError, ValueError):
        return None


def write_json(path, value):
    temporary = Path(str(path) + ".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")
    temporary.replace(path)


def wait_for(predicate, timeout=10):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        value = predicate()
        if value:
            return value
        time.sleep(0.02)
    raise TimeoutError("independent setup/observation did not become ready")


def pin_source(ref, output):
    if not re.fullmatch(r"[0-9a-f]{40}", ref):
        raise ValueError("source must be a full commit SHA")
    hashes = {}
    for relative in ("native/computer-use-linux/runtime.py", "native/computer-use-windows/runtime.ps1"):
        data = subprocess.check_output(["git", "show", f"{ref}:{relative}"], cwd=REPO)
        destination = output / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(data)
        hashes[relative] = hashlib.sha256(data).hexdigest()
    return {"sha": ref, "files": hashes}


class Trial:
    def __init__(self, args, directory, log):
        self.args, self.directory, self.log = args, directory, log
        self.instance = uuid.uuid4().hex
        directory.mkdir()
        self.targets = ProcessScope(str(directory))
        self.engines = ProcessScope(str(directory))
        self.sampler = self.typer = None
        self.state_path = directory / "state.json"
        self.sentinel_path = directory / "sentinel.json"
        self.nonce = None

    def spawn_target(self, command, **extra):
        env = {**os.environ, "BENCH_INSTANCE": self.instance, "BENCH_STATE_DIR": str(self.directory)}
        return self.targets.spawn(command, stdout=self.log, stderr=self.log, env=env, **extra)

    def window(self, pid, title):
        return wait_for(lambda: obs.find_window(pid=pid, title=title) if WIN
                        else obs.find_client(pid, title), 30)

    def state(self):
        state = read_json(self.state_path)
        if state and state.get("instance") == self.instance and state.get("pid") == self.pid:
            return state
        return None

    def launch(self):
        if self.args.target == "electron":
            flags = ["--force-renderer-accessibility"] + ([] if WIN else ["--no-sandbox"])
            proc = self.spawn_target([self.args.electron, *flags, str(HERE / "electron/main.js")])
            title = "BenchElectron"
        elif WIN:
            proc = self.spawn_target(["powershell.exe", "-NoLogo", "-NoProfile", "-STA", "-File",
                                      str(HERE / "fixture_win.ps1"), "-StateDir", str(self.directory)], hidden=True)
            title = "BenchTarget"
        else:
            proc = self.spawn_target([sys.executable, str(HERE / "fixture_gtk.py"), str(self.directory)])
            title = "BenchTarget"
        self.pid = proc.pid
        self.target = self.window(proc.pid, title)
        obs.place(self.target, 60, 60, 760, 560)
        wait_for(self.state)
        proc = self.spawn_target([sys.executable, str(HERE / "sentinel.py"),
                                  str(self.sentinel_path), "880x660+20+20"], hidden=True)
        self.sentinel_pid = proc.pid
        self.sentinel = self.window(proc.pid, "BenchSentinel")
        wait_for(lambda: read_json(self.sentinel_path))
        # Tk's initial focus callback must finish before calibration or measurement.
        time.sleep(0.2)

    def front(self):
        if WIN:
            return obs.foreground() == self.sentinel and not obs.owned_above(self.sentinel, self.pid)
        display = obs.main_display()
        stacking = display.stacking()
        windows = display.windows_of(self.pid)
        return (display.active() == self.sentinel and display.focus() in display.descendants(self.sentinel)
                and self.sentinel in stacking and self.target in stacking and windows
                and all(stacking.index(window) < stacking.index(self.sentinel) for window in windows if window in stacking))

    def prepare(self, task):
        self.nonce = uuid.uuid4().hex
        write_json(self.directory / "cmd", {"instance": self.instance, "nonce": self.nonce, "task": task})
        wait_for(lambda: prepared(self.state() or {}, task, self.instance, self.pid, self.nonce), 5)
        obs.force_foreground(self.sentinel)
        wait_for(self.front, 5)
        if WIN:
            obs.u.SetCursorPos(2, 2)
        else:
            obs.xdotool("mousemove", 2, 2)
        wait_for(lambda: prepared(self.state() or {}, task, self.instance, self.pid, self.nonce), 5)

    def sample(self):
        self.sampler = obs.Sampler(self.sentinel, self.target, self.pid)
        self.sampler.start()

    def stop_sampling(self):
        if self.sampler:
            sampler, self.sampler = self.sampler, None
            result = sampler.stop()
            if result["n_samples"] < 3:
                raise RuntimeError("observer did not collect enough samples")
            return result
        return {}

    def calibrate(self):
        self.prepare("click_interference")
        self.sample()
        self.typer = obs.Typer()
        self.typer.start()
        time.sleep(0.65)
        self.typer.stop()
        sent = self.typer.sent
        self.typer = None
        if sent < 3:
            raise RuntimeError("simulated user input control failed")
        wait_for(lambda: (read_json(self.sentinel_path) or {}).get("q", 0) == sent, 2)
        idle = self.stop_sampling()
        if any(idle[key] for key in ("sentinel_lost_focus", "target_raised", "pointer_moved", "clipboard_changed")):
            raise RuntimeError("idle observer control failed")
        self.sample()
        obs.force_foreground(self.target)
        time.sleep(0.15)
        steal = self.stop_sampling()
        if not all(steal[key] for key in ("sentinel_lost_focus", "target_activated", "target_raised")):
            raise RuntimeError("intentional focus-steal observer control failed")
        return {"idle": idle, "steal": steal, "keys_sent": sent}

    def engine(self, name, sources):
        from providers import Cua, CuaEngine, OrcaEngine, OrcaLinux, OrcaWin, cua_sc
        if name == "cua":
            client = Cua(self.args.cua, str(self.directory / "cua-home"), self.log, self.engines)
            response = client.call("list_windows", {"pid": self.pid})
            if response.get("isError") or "_rpc_error" in response:
                raise RuntimeError("cua list_windows failed: " + str(response))
            windows = cua_sc(response).get("windows") or []
            matches = [window for window in windows if window.get("window_id") is not None
                       and window.get("title") in ("BenchTarget", "BenchElectron")]
            if len(matches) != 1:
                raise DiscoveryError(f"cua list_windows matched {len(matches)} fixture windows")
            return CuaEngine(client, self.pid, matches[0]["window_id"])
        return OrcaEngine((OrcaWin if WIN else OrcaLinux)(str(sources / name), self.log, self.engines), self.pid)

    def run(self, cell, sources):
        row = {**cell, "prepared": False, "api_errors": [], "action_read_ms": [], "steps": []}
        state = None
        task_started = None
        snapshots, responses = [], []
        try:
            self.launch()
            self.prepare(cell["task"])
            row["initial_state"] = self.state()
            row["prepared"] = True
            self.sample()
            row["sentinel_before"] = read_json(self.sentinel_path)
            if cell["task"].endswith("_interference"):
                self.typer = obs.Typer()
                self.typer.start()
            task_started = time.perf_counter()
            engine = self.engine(cell["engine"], sources)
            acquire_started = time.perf_counter()
            elements = engine.snapshot()
            row["acquisition_ms"] = (time.perf_counter() - acquire_started) * 1000
            snapshots.append(engine.last_snapshot)
            for action, selector in TASKS[cell["task"]]:
                element = select_unique(elements, SELECTORS[selector])
                started = time.perf_counter()
                result = engine.act(action, element, cell["profile"] == "foreground", MARKER)
                row["steps"].append({"action": action, "result": result,
                                     "action_ms": (time.perf_counter() - started) * 1000})
                if result.get("error"):
                    row["api_errors"].append(result)
                responses.append(engine.last_response)
                # Identical extra full no-screenshot read for all providers; reuse fresh refs next step.
                elements = engine.snapshot()
                row["action_read_ms"].append((time.perf_counter() - started) * 1000)
                snapshots.append(engine.last_snapshot)
                if result.get("error"):
                    break
        except DiscoveryError as error:
            row["discovery_error"] = str(error)
        except Exception as error:
            row["api_errors"].append(repr(error))
        finally:
            if task_started is not None:
                row["attempt_ms"] = (time.perf_counter() - task_started) * 1000
            try:
                # No late operation can mutate the fixture after the terminal oracle starts.
                self.engines.close()
                if self.typer:
                    self.typer.stop()
                    row["keys_sent"] = self.typer.sent
                    self.typer = None
                if row["prepared"]:
                    if task_started is not None:
                        row["elapsed_to_quiescent_ms"] = (time.perf_counter() - task_started) * 1000
                    before = (self.state() or {}).get("seq", -1)
                    time.sleep(0.4)
                    def fresh_state():
                        value = self.state()
                        return value if value and value.get("seq", -1) > before and acknowledged(
                            value, self.instance, self.pid, self.nonce) else None
                    state = wait_for(fresh_state, 2)
                    if task_started is not None:
                        row["terminal_readback_ms"] = (time.perf_counter() - task_started) * 1000
                    row["sentinel_after"] = read_json(self.sentinel_path)
                    sentinel_before = row["sentinel_before"]
                    sentinel_after = row["sentinel_after"]
                    if not all(value and value.get("pid") == self.sentinel_pid
                               for value in (sentinel_before, sentinel_after)):
                        raise RuntimeError("missing independent sentinel counters")
                    if cell["task"].endswith("_interference") and row.get("keys_sent", 0) == 0:
                        row["input_observer_error"] = "no simulated user input was delivered"
                    row["keys_received"] = sentinel_after.get("q", 0) - sentinel_before.get("q", 0)
                    row["keys_lost"] = max(0, row.get("keys_sent", 0) - row["keys_received"])
                    row["agent_text_in_sentinel"] = sentinel_after.get("other", 0) - sentinel_before.get("other", 0)
                    row["target_q_characters"] = state["text"].count("q") + state["decoyText"].count("q")
            except Exception as error:
                row["terminal_observation_error"] = repr(error)
            try:
                row["observation"] = self.stop_sampling()
            except Exception as error:
                row["observer_error"] = repr(error)
            row["final_state"] = state
            row["verdict"] = verdict(row, state)
        for index, snapshot in enumerate(snapshots):
            write_json(self.directory / f"snapshot-{index}.json", snapshot)
        for index, response in enumerate(responses):
            write_json(self.directory / f"response-{index}.json", response)
        return row

    def close(self):
        if self.typer:
            self.typer.stop()
        try:
            self.engines.close()
        finally:
            try:
                self.stop_sampling()
            finally:
                self.targets.close()


def markdown(meta, summary):
    lines = [f"## {meta['os']} / {meta['target']}", "",
             f"Run complete: {meta['complete']}. Cells: {meta['executed']}/{meta['planned']}. Seed: {meta['seed']}.", "",
             "| task | profile | engine | completed/scored | invalid | unobserved | API errors | task ms | action + read ms | focus lost | raised |",
             "|---|---|---|---|---|---|---|---|---|---|---|"]
    for row in summary:
        lines.append(f"| {row['task']} | {row['profile']} | {row['engine']} | {row['completed']}/{row['scored']} | "
                     f"{row['invalid']} | {row['unobserved']} | {row['api_errors']} | {row['task_ms']} | "
                     f"{row['action_read_ms']} | {row['sentinel_lost_focus']} | {row['target_raised']} |")
    if meta.get("fatal"):
        lines.extend(["", f"Incomplete: `{meta['fatal']}`"])
    return "\n".join(lines) + "\n"


def main():
    if (os.environ.get("ORCA_COMPUTER_BENCH_ISOLATED") != "1" or os.environ.get("GITHUB_ACTIONS") != "true"
            or os.environ.get("ORCA_BACKGROUND_LAUNCH") != "1" or sys.platform not in ("linux", "win32")):
        raise SystemExit("Native input benchmark requires the isolated Linux/Windows GitHub Actions desktop")
    global obs
    if WIN:
        import obs_win as obs
    else:
        import obs_x11 as obs
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--target", choices=["fixture", "electron"], required=True)
    parser.add_argument("--cua", required=True)
    parser.add_argument("--electron")
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--baseline", default="030c88deecf3adc212d22f57b085e4bd5c6e48e6")
    parser.add_argument("--candidate", required=True)
    parser.add_argument("--n", type=int, default=3)
    parser.add_argument("--seed", type=int, default=417)
    parser.add_argument("--budget", type=int, default=1800)
    args = parser.parse_args()
    if args.n < 1 or (args.target == "electron" and not args.electron):
        parser.error("positive --n and an Electron executable for Electron targets are required")
    args.out = args.out.resolve()
    args.out.mkdir(parents=True, exist_ok=False)
    sources = args.out / "sources"
    cells = []
    for cell in schedule(["baseline", "candidate", "cua"], TASKS, args.n, args.seed):
        profiles = ["background", "foreground"] if not cell["task"].endswith("_interference") else ["background"]
        cells.extend({**cell, "profile": profile} for profile in profiles)
    meta = {"os": platform.platform(), "target": args.target, "seed": args.seed, "n": args.n,
            "python": sys.version, "image": os.environ.get("ImageVersion"), "planned": len(cells),
            "complete": False, "executed": 0, "sources": {}}
    rows = []
    started = time.monotonic()
    try:
        meta["sources"] = {name: pin_source(sha, sources / name)
                           for name, sha in (("baseline", args.baseline), ("candidate", args.candidate))}
        meta["cua_sha256"] = hashlib.sha256(Path(args.cua).read_bytes()).hexdigest()
        meta["cua_version"] = subprocess.check_output([args.cua, "--version"], text=True, timeout=15).strip()
        if "0.38.0" not in meta["cua_version"]:
            raise RuntimeError("expected pinned cua-driver 0.38.0")
        with (args.out / "engines.log").open("ab") as log:
            control = Trial(args, args.out / "controls", log)
            try:
                control.launch()
                meta["calibration"] = control.calibrate()
            finally:
                control.close()
            for index, cell in enumerate(cells):
                if time.monotonic() - started >= args.budget:
                    raise TimeoutError("budget exhausted; planned cells remain")
                trial = Trial(args, args.out / f"trial-{index:03d}", log)
                try:
                    row = trial.run(cell, sources)
                    rows.append(row)
                finally:
                    trial.close()
                meta["executed"] = len(rows)
                write_json(args.out / "results.json", {"meta": meta, "rows": rows})
                print(f"{index + 1}/{len(cells)} {cell}: {row['verdict']}", flush=True)
            meta["complete"] = (len(rows) == len(cells) and all(row["prepared"] and not row.get("observer_error")
                                 and not row.get("terminal_observation_error") and not row.get("input_observer_error") and row["verdict"] != "unobserved" for row in rows))
    except Exception as error:
        import traceback
        traceback.print_exc()
        meta["fatal"] = repr(error)
    finally:
        meta["executed"] = len(rows)
        meta["elapsed_seconds"] = time.monotonic() - started
        summary = summarize(rows)
        write_json(args.out / "results.json", {"meta": meta, "summary": summary, "rows": rows, "plan": cells})
        report = markdown(meta, summary)
        (args.out / "summary.md").write_text(report, encoding="utf-8")
        print(report)
        if os.environ.get("GITHUB_STEP_SUMMARY"):
            with open(os.environ["GITHUB_STEP_SUMMARY"], "a", encoding="utf-8") as stream:
                stream.write(report)
    return 0 if meta["complete"] else 1


if __name__ == "__main__":
    sys.exit(main())
