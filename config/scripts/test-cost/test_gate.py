#!/usr/bin/env python3
"""Bounded, host-wide test admission; no third-party Python dependencies."""
import argparse
import collections
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import signal
import subprocess
import sys
import time
import uuid


class GateError(Exception):
    pass


def say(message):
    print("test_gate: " + message, file=sys.stderr, flush=True)


def run_output(args, timeout=15):
    return subprocess.check_output(args, stderr=subprocess.DEVNULL, timeout=timeout).decode().strip()


def number(name, default, minimum=0):
    try:
        value = float(os.environ.get(name, default))
        if value < minimum or not value < float("inf"):
            raise ValueError()
        return value
    except ValueError:
        raise GateError(f"{name} must be a finite number >= {minimum}")


def append_log(path, record):
    # Separate append lock also covers admission denials before the run lock.
    with path.open("a") as out:
        fcntl.flock(out, fcntl.LOCK_EX)
        out.write(json.dumps(record, ensure_ascii=False, sort_keys=True) + "\n")
        out.flush()
        os.fsync(out.fileno())


def report(path, as_json=False):
    totals = collections.defaultdict(lambda: {"runs": 0, "seconds": 0, "max_seconds": 0, "over_budget": 0, "containers_observed": 0, "resource_unmeasured_runs": 0})
    if path.exists():
        for line in path.read_text().splitlines():
            try:
                row = json.loads(line)
            except ValueError:
                continue
            if row.get("event") != "end":
                continue
            item = totals[row["repo"]]
            item["runs"] += 1
            item["seconds"] += row["seconds"]
            item["max_seconds"] = max(item["max_seconds"], row["seconds"])
            item["over_budget"] += int(row.get("over_budget", False))
            item["containers_observed"] += row.get("containers_observed") or 0
            item["resource_unmeasured_runs"] += int(row.get("containers_observed") is None)
    rows = sorted((dict(repo=repo, **data) for repo, data in totals.items()), key=lambda row: row["seconds"], reverse=True)
    if as_json:
        print(json.dumps(rows, ensure_ascii=False, indent=2))
    else:
        print("seconds\truns\tmax_s\tover_budget\tcontainers_observed\tresource_unmeasured_runs\trepo")
        for row in rows:
            print(f'{row["seconds"]:.2f}\t{row["runs"]}\t{row["max_seconds"]:.2f}\t{row["over_budget"]}\t{row["containers_observed"]}\t{row["resource_unmeasured_runs"]}\t{row["repo"]}')
    return 0


def guarded_package_command(argv, cwd=None):
    """Recognize one concrete package script whose whole execution enters our selector.

    This is a convenience exemption, not a shell sandbox. Workspace aggregates,
    lifecycle hooks, shell chains, and string mentions are deliberately excluded.
    """
    if not argv or Path(argv[0]).name not in ("npm", "pnpm", "yarn", "bun"):
        return False
    directory = Path(cwd or Path.cwd())
    args = list(argv[1:])
    while args and args[0].startswith("-"):
        option = args.pop(0)
        if option in ("--prefix", "--cwd", "--dir", "-C") and args:
            directory = (directory / args.pop(0)).resolve()
        elif option.startswith(("--prefix=", "--cwd=", "--dir=")):
            directory = (directory / option.split("=", 1)[1]).resolve()
        elif option in ("--silent", "--quiet", "-s"):
            continue
        else:
            return False
    if args[:1] in (["run"], ["run-script"]):
        args.pop(0)
    if not args or args[0].startswith("-"):
        return False
    script_name = args[0]
    try:
        scripts = json.loads((directory / "package.json").read_text()).get("scripts", {})
        script = scripts.get(script_name, "")
        if not isinstance(script, str) or not script or scripts.get("pre" + script_name) or scripts.get("post" + script_name):
            return False
        lexer = shlex.shlex(script, posix=True, punctuation_chars=";&|()<>")
        lexer.whitespace_split = True
        words = list(lexer)
        if any(word and all(char in ";&|()<>" for char in word) for word in words):
            return False
        while words and re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*=.*", words[0], re.DOTALL):
            words.pop(0)
        if len(words) < 3:
            return False
        if Path(words[0]).name == "node":
            dispatcher = (directory / words[1]).resolve()
            if dispatcher.name != "test-cost-entry.mjs" or not dispatcher.is_file():
                return False
            runtime = dispatcher.parent / "test-cost"
            if not all((runtime / name).is_file() for name in ("affected_tests.py", "test_gate.sh", "test_gate.py")):
                return False
            tail = words[2:]
            if tail and tail[0].startswith("--native-runtime="):
                if tail.pop(0) not in ("--native-runtime=node", "--native-runtime=electron"):
                    return False
            return bool(tail and tail[0] in ("vitest", "jest", "playwright"))
        if Path(words[0]).name not in ("python3", "python"):
            return False
        helper = (directory / words[1]).resolve()
        if helper.name != "affected_tests.py" or not helper.is_file():
            return False
        if not all(helper.with_name(name).is_file() for name in ("test_gate.sh", "test_gate.py")):
            return False
        tail = words[2:]
        if tail[:1] == ["--shell-launcher-json"]:
            if len(tail) < 3:
                return False
            launcher = json.loads(tail[1])
            if not isinstance(launcher, list) or not launcher or any(not isinstance(word, str) or not word for word in launcher):
                return False
            tail = tail[2:]
        return len(tail) >= 2 and tail[0] == "--" and Path(tail[1]).name in ("vitest", "jest", "playwright", "pytest")
    except (OSError, ValueError, TypeError, AttributeError):
        return False


def is_broad(argv):
    """Recognize broad builtin runners; scripts declare scope via --scope/full env."""
    if not argv:
        return False
    args = list(argv)
    while args and ("=" in args[0] or Path(args[0]).name in ("env", "exec", "command", "time", "npx", "pnpx", "bunx")):
        args.pop(0)
    if not args:
        return False
    name = Path(args[0]).name
    tail = args[1:]
    if name in ("sh", "bash", "zsh") and len(tail) >= 2 and tail[0] in ("-c", "-lc", "-ec", "-xc"):
        try:
            # Shell command punctuation only outside quotes; conservative on compound commands.
            lexer = shlex.shlex(tail[1], posix=True, punctuation_chars=";&|()\n")
            lexer.whitespace_split = True
            segment = []
            for token in list(lexer) + [";"]:
                if token and all(char in ";&|()\n" for char in token):
                    if is_broad(segment):
                        return True
                    segment = []
                else:
                    segment.append(token)
            return False
        except ValueError:
            raise GateError("invalid shell command quoting")
    if name in ("uv", "poetry", "pipenv") and tail and tail[0] == "run":
        return is_broad(tail[1:])
    if name in ("python", "python3") and tail[:2] == ["-m", "pytest"]:
        return is_broad(["pytest"] + tail[2:])
    if name == "go" and tail and tail[0] == "test":
        return any(arg == "..." or arg.endswith("/...") for arg in tail)
    if name.startswith("gradle"):
        tasks = [arg for arg in tail if ":" not in arg.strip(":" )]
        return bool(set(tasks) & {"test", "check", "build", "integrationTest", "e2eTest"}) and not any(arg == "--tests" or arg.startswith("--tests=") for arg in tail)
    if name in ("mvn", "mvnw", "mvnw.cmd"):
        return bool(set(tail) & {"test", "verify", "install", "package", "integration-test"}) and not any(arg.startswith(("-Dtest=", "-Dit.test=")) for arg in tail)
    if name in ("npm", "pnpm", "yarn", "bun"):
        if guarded_package_command(args):
            return False
        # Unknown workspace/recursive forms remain broad when their script is a test.
        while tail and tail[0].startswith("-"):
            option = tail.pop(0)
            if option in ("--filter", "-F", "--prefix", "-C", "--cwd", "--workspace", "-w", "--dir") and tail:
                tail.pop(0)
        if tail and tail[0] in ("exec", "dlx", "x"):
            return is_broad(tail[1:])
        if tail and tail[0] in ("run", "run-script"):
            tail = tail[1:]
        if tail and tail[0] in ("vitest", "jest", "playwright", "cypress"):
            return is_broad(tail)
        if tail and (tail[0] in ("test", "check", "ci", "e2e") or tail[0].startswith("test:")):
            return not any(not arg.startswith("-") and ("/" in arg or re.search(r"\.(?:[cm]?[jt]sx?|vue)$", arg)) for arg in tail[1:])
    if name in ("pytest", "py.test", "vitest", "jest", "playwright", "cypress"):
        positional = []
        skip = False
        options_with_value = {"-c", "--config", "-m", "-p", "-o", "-n", "--project", "--browser", "--reporter", "--output", "--tb", "--rootdir", "--maxfail", "--junitxml", "--cov", "--durations"}
        for arg in tail:
            if skip:
                skip = False
                continue
            if arg in ("-k", "-t", "--testNamePattern", "--grep", "--spec", "--changed", "--changedSince", "--only-changed") or arg.startswith(("--spec=", "--grep=", "--testNamePattern=", "--changed=", "--changedSince=", "--only-changed=")):
                return False
            if arg in options_with_value:
                skip = True
            elif not arg.startswith("-") and arg not in ("test", "run", "watch", "related", "list"):
                positional.append(arg)
        return not positional or any(arg in (".", "./", "tests", "tests/", "test", "test/") for arg in positional)
    if name == "cargo" and "test" in tail:
        return not any(arg in ("--test", "--bin", "--example") for arg in tail) and not any(not arg.startswith("-") for arg in tail[tail.index("test") + 1:])
    return False


def repo_revision():
    cwd = str(Path.cwd().resolve())
    try:
        root = run_output(["git", "rev-parse", "--show-toplevel"])
        common = str(Path(run_output(["git", "rev-parse", "--git-common-dir"])).resolve())
        head = run_output(["git", "rev-parse", "HEAD"])
        digest = hashlib.sha256()
        digest.update(subprocess.check_output(["git", "diff", "--binary", "HEAD", "--", ".", ":(exclude).dev"], cwd=root, timeout=30))
        untracked = subprocess.check_output(["git", "ls-files", "--others", "--exclude-standard", "-z"], cwd=root, timeout=15)
        for relative in sorted(untracked.split(b"\0")):
            if not relative or relative.startswith(b".dev/"):
                continue
            path = Path(root) / os.fsdecode(relative)
            digest.update(relative + b"\0")
            if path.is_symlink():
                digest.update(os.fsencode(os.readlink(path)))
            elif path.is_file():
                with path.open("rb") as src:
                    for chunk in iter(lambda: src.read(1024 * 1024), b""):
                        digest.update(chunk)
        return root, common, head + ":" + digest.hexdigest()
    except (subprocess.CalledProcessError, FileNotFoundError):
        return cwd, cwd, "no-git"


def live(pid):
    try:
        os.kill(int(pid), 0)
        return True
    except (ValueError, TypeError, ProcessLookupError):
        return False
    except PermissionError:
        return True


def read_owner(slot):
    try:
        data = (slot / "owner.json").read_text()
        return json.loads(data)
    except (OSError, ValueError):
        return {}


def ancestor(pid):
    parent = os.getppid()
    for _ in range(64):
        if parent == pid:
            return True
        if parent <= 1:
            return False
        try:
            parent = int(run_output(["ps", "-o", "ppid=", "-p", str(parent)], timeout=2))
        except (OSError, ValueError, subprocess.SubprocessError):
            return False
    return False


def verified_nested(slot):
    token = os.environ.get("TEST_GATE_TOKEN")
    owner = read_owner(slot)
    return bool(token and token == owner.get("token") and live(owner.get("pid")) and ancestor(owner["pid"]))


def acquire(lock_file, slot, wait_seconds, maxload):
    deadline = time.monotonic() + wait_seconds
    next_notice = 0
    acquired = False
    while True:
        if not acquired:
            try:
                fcntl.flock(lock_file, fcntl.LOCK_EX | fcntl.LOCK_NB)
                acquired = True
            except BlockingIOError:
                pass
        if acquired:
            # Compatibility with pre-install mkdir gates still running in another session.
            if slot.exists():
                try:
                    pid = (slot / "owner").read_text().splitlines()[0]
                except (OSError, IndexError):
                    pid = None
                age = time.time() - slot.stat().st_mtime
                if (pid and not live(pid)) or (not pid and age > 30):
                    # Never recursively delete unknown contents. A legacy/new owner only writes these names.
                    for filename in ("owner", "owner.json"):
                        (slot / filename).unlink(missing_ok=True)
                    try:
                        slot.rmdir()
                    except OSError:
                        raise GateError(f"unrecognized stale gate slot contents: {slot}")
            if not slot.exists():
                try:
                    slot.mkdir(mode=0o700)
                    (slot / "owner").write_text(f"{os.getpid()}\n{Path.cwd()}\nstarting\n")
                    break
                except FileExistsError:
                    pass
        if time.monotonic() >= deadline:
            raise GateError(f"wait budget exhausted after {wait_seconds:g}s; no test started")
        if time.monotonic() >= next_notice:
            say("waiting for machine slot")
            next_notice = time.monotonic() + 60
        time.sleep(min(0.2, max(0, deadline - time.monotonic())))
    while os.getloadavg()[0] >= maxload:
        if time.monotonic() >= deadline:
            release_slot(slot, None)
            raise GateError(f"load wait budget exhausted ({os.getloadavg()[0]:.1f} >= {maxload:g}); no test started")
        if time.monotonic() >= next_notice:
            say(f"waiting for load {os.getloadavg()[0]:.1f} < {maxload:g}")
            next_notice = time.monotonic() + 60
        time.sleep(min(1, max(0, deadline - time.monotonic())))


def release_slot(slot, token):
    owner = read_owner(slot)
    if token and owner.get("token") != token:
        return
    try:
        pid = (slot / "owner").read_text().splitlines()[0]
        if pid != str(os.getpid()):
            return
        (slot / "owner.json").unlink(missing_ok=True)
        (slot / "owner").unlink(missing_ok=True)
        slot.rmdir()
    except (OSError, IndexError):
        pass


class DockerRun:
    """Only exact run-label resources; repo-specific owners still need their lifecycle runner."""
    def __init__(self, session):
        self.session = session
        self.seen = set()
        self.cli = ["docker"]
        if not os.environ.get("DOCKER_HOST"):
            context = run_output(["docker", "context", "show"], timeout=10)
            self.cli += ["--context", context]
        self.endpoint = os.environ.get("DOCKER_HOST") or context
        self.list_ids("container")  # fail before tests when unavailable

    def call(self, *args):
        return run_output(self.cli + list(args), timeout=15)

    def list_ids(self, kind):
        flag = f"label=org.testcontainers.sessionId={self.session}"
        args = ("ps", "-aq", "--filter", flag) if kind == "container" else (kind, "ls", "-q", "--filter", flag)
        ids = self.call(*args).split()
        if kind == "container":
            self.seen.update(ids)
        return ids

    def cleanup(self):
        errors = []
        leftovers = {}
        for kind in ("container", "volume", "network"):
            try:
                ids = self.list_ids(kind)
                for item in ids:
                    args = ("rm", "-f", item) if kind == "container" else (kind, "rm", item)
                    self.call(*args)
                leftovers[kind] = len(self.list_ids(kind))
            except (OSError, subprocess.SubprocessError) as error:
                errors.append(f"{kind}: {error}")
                leftovers[kind] = None
        return leftovers, errors


def main():
    if len(sys.argv) > 1 and sys.argv[1] == "check-package-command":
        args = sys.argv[2:]
        if args[:1] == ["--"]:
            args = args[1:]
        return 0 if guarded_package_command(args) else 1
    locks = Path(os.environ.get("HARNESS_LOCK_DIR", str(Path.home() / ".claude/locks"))).expanduser().resolve()
    locks.mkdir(parents=True, exist_ok=True)
    log = locks / "test-gate.log"
    if len(sys.argv) > 1 and sys.argv[1] == "check-held":
        return 0 if verified_nested(locks / "test-gate.slot") else 1
    if len(sys.argv) > 1 and sys.argv[1] == "report":
        return report(log, "--json" in sys.argv[2:])
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--scope", choices=("affected", "full"), default=os.environ.get("TEST_GATE_SCOPE", "affected"))
    parser.add_argument("command", nargs=argparse.REMAINDER)
    opts = parser.parse_args()
    if opts.scope not in ("affected", "full"):
        parser.error("TEST_GATE_SCOPE must be affected or full")
    command = opts.command
    if command[:1] == ["--"]:
        command = command[1:]
    if not command:
        parser.error("a command is required (or use report)")
    reason = os.environ.get("TEST_GATE_FULL", "").strip()
    rerun = os.environ.get("TEST_GATE_RERUN", "").strip()
    full = opts.scope == "full" or is_broad(command) or any(os.environ.get(key) == "1" for key in ("FULL_IT", "FULL_TEST", "FULL_TESTS"))
    if full and not reason:
        append_log(log, dict(event="denied", time=time.time(), repo=str(Path.cwd()), command=command, reason="full scope requires TEST_GATE_FULL"))
        raise GateError("full scope requires TEST_GATE_FULL=<reason>; select affected tests by default")
    slot = locks / "test-gate.slot"
    if verified_nested(slot):
        append_log(log, dict(event="nested", time=time.time(), repo=str(Path.cwd()), command=command, full_reason=reason, owner=read_owner(slot)["pid"]))
        os.execvpe(command[0], command, os.environ)
    normalized = list(command)
    if len(normalized) >= 3 and Path(normalized[0]).name in ("sh", "bash", "zsh") and normalized[1] in ("-c", "-lc", "-ec", "-xc"):
        normalized[2] = shlex.join(shlex.split(normalized[2]))
    records = locks / "test-gate-runs"
    records.mkdir(exist_ok=True)
    token = uuid.uuid4().hex
    child = None
    interrupted = None
    docker = None
    start = time.monotonic()
    # Repository lifecycle owners may need 10s to stop descendants plus 90s
    # for verified Docker cleanup. Admission stays locked until this grace ends.
    stop_grace = number("TEST_GATE_STOP_GRACE_SECONDS", 120, 0.05)
    if stop_grace > 300:
        raise GateError("TEST_GATE_STOP_GRACE_SECONDS must be <= 300")

    def interrupt(signum, frame):
        nonlocal interrupted
        interrupted = signum
        if child is not None:
            try:
                os.killpg(child.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
        else:
            raise GateError(f"interrupted by signal {signum} before test start")

    with (locks / "test-gate.lock").open("a+") as lock_file:
        try:
            for sig in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
                signal.signal(sig, interrupt)
            acquire(lock_file, slot, number("TEST_GATE_WAIT_SECONDS", 900), number("TEST_GATE_MAXLOAD", 20, 0.01))
            (slot / "owner.json").write_text(json.dumps(dict(pid=os.getpid(), token=token)))
            root, identity, revision = repo_revision()
            config_path = Path(root) / ".test-gate.json"
            config = json.loads(config_path.read_text()) if config_path.exists() else {}
            budget = number("TEST_GATE_BUDGET_SECONDS", config.get("budget_seconds", 600), 0.01)
            budget_action = config.get("budget_action", "warn")
            if budget_action not in ("warn", "fail"):
                raise GateError(".test-gate.json budget_action must be warn or fail")
            # Worktree-local absolute script paths must not create separate full-run permits.
            normalized = [
                (str(Path(arg).resolve()) if os.path.isabs(arg) and Path(arg).exists() else arg)
                .replace(root + os.sep, '<repo>/') for arg in normalized
            ]
            key = hashlib.sha256(json.dumps([identity, revision, str(Path.cwd().resolve().relative_to(root)), normalized], sort_keys=True).encode()).hexdigest()
            record_path = records / (key + ".json")
            canonical_repo = str(Path(identity).parent) if Path(identity).name == ".git" else root
            details = dict(repo=canonical_repo, worktree=root, revision=revision, command=command, full=full, full_reason=reason, rerun_reason=rerun, key=key, pid=os.getpid(), token=token, stop_grace_seconds=stop_grace)
            if record_path.exists() and not rerun:
                append_log(log, dict(details, event="denied", time=time.time(), reason="repeat requires TEST_GATE_RERUN"))
                raise GateError("same revision and command already attempted; rerun only the failed package, or set TEST_GATE_RERUN=<reason>")
            env = os.environ.copy()
            env.update(TEST_GATE_HELD="1", TEST_GATE_TOKEN=token, TEST_GATE_OWNER_PID=str(os.getpid()), TEST_GATE_SCOPE=opts.scope)
            # Always allocate a fresh ID: an inherited ID must not claim another run's resources.
            env["TESTCONTAINERS_SESSION_ID"] = "gate-" + token
            receipt_dir = locks / "test-gate-receipts"
            receipt_dir.mkdir(exist_ok=True)
            receipt_path = receipt_dir / (token + ".json")
            env["TEST_GATE_RESOURCE_RECEIPT"] = str(receipt_path)
            if os.environ.get("TEST_GATE_DOCKER") == "1":
                docker = DockerRun(env["TESTCONTAINERS_SESSION_ID"])
                details["docker_endpoint"] = docker.endpoint
            details["docker_session"] = env["TESTCONTAINERS_SESSION_ID"]
            record_path.write_text(json.dumps(dict(details, event="start", time=time.time())))
            append_log(log, dict(details, event="start", time=time.time(), budget_seconds=budget))
            start = time.monotonic()
            child = subprocess.Popen(command, env=env, start_new_session=True, pass_fds=(lock_file.fileno(),))
            next_poll = 0
            signal_time = None
            docker_errors = []
            while child.poll() is None:
                now = time.monotonic()
                if interrupted:
                    signal_time = signal_time or now
                    if now - signal_time >= stop_grace:
                        try:
                            os.killpg(child.pid, signal.SIGKILL)
                        except ProcessLookupError:
                            pass
                if docker is not None and now >= next_poll:
                    try:
                        docker.list_ids("container")
                    except (OSError, subprocess.SubprocessError) as error:
                        docker_errors.append(str(error))
                    next_poll = now + 2
                time.sleep(0.05)
            rc = child.wait()
            rc = 128 - rc if rc < 0 else rc
            if interrupted:
                rc = 128 + interrupted
            # Background grandchildren must not keep creating resources while cleanup runs.
            try:
                os.killpg(child.pid, signal.SIGTERM)
                group_deadline = (signal_time if signal_time is not None else time.monotonic()) + stop_grace
                while True:
                    try:
                        os.killpg(child.pid, 0)
                    except ProcessLookupError:
                        break
                    if time.monotonic() >= group_deadline:
                        os.killpg(child.pid, signal.SIGKILL)
                        break
                    time.sleep(0.05)
                if rc == 0:
                    rc = 70
                say("command left background processes; terminated owned process group")
            except ProcessLookupError:
                pass
            leftovers = None
            if docker:
                leftovers, errors = docker.cleanup()
                docker_errors.extend(errors)
                if errors or any(value != 0 for value in leftovers.values()):
                    rc = rc or 70
            receipt = None
            receipt_error = None
            if receipt_path.exists():
                try:
                    if receipt_path.stat().st_size > 65536:
                        raise ValueError("resource receipt exceeds 64KiB")
                    receipt = json.loads(receipt_path.read_text())
                    if not isinstance(receipt, dict):
                        raise ValueError("resource receipt must be an object")
                    for field in ("container_count", "container_stop_count"):
                        if type(receipt.get(field)) is not int or receipt[field] < 0:
                            raise ValueError("invalid receipt " + field)
                    if receipt.get("terminated") is not True or receipt.get("cleanup_error") or receipt.get("observation_error"):
                        raise ValueError("repository lifecycle did not verify cleanup")
                except (OSError, ValueError) as error:
                    receipt_error = str(error)
                    rc = rc or 70
            elif os.environ.get("TEST_GATE_EXPECT_RESOURCE_RECEIPT") == "1":
                receipt_error = "expected repository resource receipt missing"
                rc = rc or 70
            elapsed = round(time.monotonic() - start, 3)
            over = elapsed > budget
            if over:
                say(f"budget exceeded: {elapsed:.2f}s > {budget:g}s ({budget_action})")
                if budget_action == "fail":
                    rc = rc or 124
            result = dict(details, event="end", time=time.time(), rc=rc, seconds=elapsed, budget_seconds=budget, over_budget=over,
                          containers_observed=receipt.get("container_count") if receipt and not receipt_error else (len(docker.seen) if docker else None),
                          resource_receipt=receipt, resource_receipt_error=receipt_error,
                          resource_receipt_path=str(receipt_path) if receipt_path.exists() else None,
                          leftovers=leftovers, docker_errors=docker_errors,
                          docker_accounting=("repository receipt: " + str(receipt.get("measurement", "lifecycle"))) if receipt and not receipt_error else ("sampled exact-label resources" if docker else "disabled; use repo lifecycle runner for Docker"))
            append_log(log, result)
            record_path.write_text(json.dumps(result))
            say(f"rc={rc} {elapsed:.2f}s repo={root} containers_observed={result['containers_observed']} leftovers={leftovers}")
            return rc
        finally:
            if child is not None and child.poll() is None:
                try:
                    os.killpg(child.pid, signal.SIGKILL)
                    child.wait(timeout=5)
                except (ProcessLookupError, subprocess.TimeoutExpired):
                    pass
            # Do not claim successful cleanup after an unexpected exception. The start record remains.
            release_slot(slot, token if read_owner(slot) else None)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (GateError, OSError, ValueError, subprocess.SubprocessError) as error:
        say(str(error))
        sys.exit(75)
