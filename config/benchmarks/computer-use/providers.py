"""Direct native-provider transports, adapted from bench/computer-cua at 68a68ccf0f16."""
import json
import os
import queue
import re
import sys
import subprocess
import threading
import time

WIN = sys.platform == "win32"


def now():
    return time.perf_counter() * 1000


def md_rows(text, snapshot_id):
    out = []
    for line in (text or "").splitlines():
        match = re.match(r'\s*-\s*\[(\d+)\]\s*(.*)', line)
        if match:
            body = match.group(2)
            role = re.split(r'["\[(]', body, maxsplit=1)[0].strip()
            out.append({"role": role, "label": body[len(role):],
                        "element_token": f"{snapshot_id}:{match.group(1)}"})
    return out


class Cua:
    """cua-driver over MCP stdio, `mcp --direct` (the process owns the runtime on Windows/Linux)."""

    def __init__(self, exe, home, logf, processes):
        env = dict(os.environ)
        env.update({
            "CUA_DRIVER_RS_TELEMETRY_ENABLED": "0", "CUA_TELEMETRY_ENABLED": "0", "DO_NOT_TRACK": "1",
            "CUA_DRIVER_RS_UPDATE_CHECK": "0", "CUA_DRIVER_RS_HOME": home, "CUA_HOME": home,
            "CUA_DRIVER_TELEMETRY_HOME": home,
            # Disposable CI desktop, as in cua's own live-smoke workflow: no interactive approvals.
            "CUA_DRIVER_PERMISSION_MODE": "unrestricted", "CUA_DRIVER_DANGEROUSLY_BYPASS_APPROVALS": "1",
        })
        os.makedirs(home, exist_ok=True)
        t0 = now()
        self.p = processes.spawn([exe, "mcp", "--direct", "--no-overlay"], stdin=subprocess.PIPE,
                                  stdout=subprocess.PIPE, stderr=logf, env=env)
        self.pid = self.p.pid
        self.q = {}
        self.cv = threading.Condition()
        self.nid = 0
        threading.Thread(target=self._reader, daemon=True).start()
        init = self.rpc("initialize", {"protocolVersion": "2025-06-18", "capabilities": {},
                                       "clientInfo": {"name": "orca-bench", "version": "0"}}, timeout=60)
        self._send({"jsonrpc": "2.0", "method": "notifications/initialized"})
        self.startup_ms = round(now() - t0, 1)
        self.server_info = (init or {}).get("serverInfo")

    def _reader(self):
        for line in self.p.stdout:
            line = line.strip()
            if not line:
                continue
            try:
                m = json.loads(line.decode("utf-8", "replace"))
            except ValueError:
                continue
            if "id" in m:
                with self.cv:
                    self.q[m["id"]] = (m, len(line))
                    self.cv.notify_all()

    def _send(self, obj):
        self.p.stdin.write((json.dumps(obj) + "\n").encode())
        self.p.stdin.flush()

    def rpc(self, method, params, timeout=30):
        with self.cv:
            self.nid += 1
            i = self.nid
        self._send({"jsonrpc": "2.0", "id": i, "method": method, "params": params})
        end = time.time() + timeout
        with self.cv:
            while i not in self.q:
                left = end - time.time()
                if left <= 0:
                    raise TimeoutError(method)
                self.cv.wait(left)
            m, n = self.q.pop(i)
        self.last_raw = n
        if "error" in m:
            return {"_rpc_error": m["error"]}
        return m["result"]

    def call(self, tool, args, timeout=30):
        t0 = now()
        r = self.rpc("tools/call", {"name": tool, "arguments": args}, timeout)
        r["_ms"] = now() - t0
        r["_raw"] = self.last_raw
        return r



def cua_text(r):
    return "\n".join(c.get("text", "") for c in r.get("content") or [] if c.get("type") == "text")


def cua_sc(r):
    return r.get("structuredContent") or {}


class OrcaWin:
    """runtime.ps1 -Serve over NDJSON, as DesktopScriptRuntimeHost runs it."""

    def __init__(self, root, logf, processes):
        script = os.path.join(root, "native", "computer-use-windows", "runtime.ps1")
        t0 = now()
        self.p = processes.spawn(["powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive",
                                   "-File", script, "-Serve"], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=logf,
                                  hidden=True)
        self.pid = self.p.pid
        self.lines = queue.Queue()
        threading.Thread(target=self._reader, daemon=True).start()
        ready = self.lines.get(timeout=120)
        if '"ready"' not in ready:
            raise RuntimeError("runtime.ps1 did not announce readiness: " + ready[:200])
        self.startup_ms = round(now() - t0, 1)
        self.rid = 0

    def _reader(self):
        for line in self.p.stdout:
            self.lines.put(line.decode("utf-8", "replace").strip())

    def op(self, req, timeout=30):
        self.rid += 1
        req = {**req, "requestId": self.rid}
        t0 = now()
        self.p.stdin.write((json.dumps(req) + "\n").encode("utf-8"))
        self.p.stdin.flush()
        end = time.time() + timeout
        while True:
            line = self.lines.get(timeout=max(0.01, end - time.time()))
            try:
                m = json.loads(line)
            except ValueError:
                continue
            if m.get("requestId") == self.rid:
                return m, now() - t0, len(line)



class OrcaLinux:
    """One subprocess per operation, matching the Linux production transport."""

    def __init__(self, root, logf, processes):
        self.script = os.path.join(root, "native", "computer-use-linux", "runtime.py")
        self.logf, self.processes = logf, processes
        self.path = os.path.join(processes.directory, "operation.json")

    def op(self, req, timeout=30):
        with open(self.path, "w", encoding="utf-8") as stream:
            json.dump(req, stream)
        started = now()
        proc = self.processes.spawn([sys.executable, self.script, self.path],
                                    stdout=-1, stderr=self.logf)
        raw, _ = proc.communicate(timeout=timeout)
        text = raw.decode("utf-8", "replace")
        try:
            result = json.loads(text)
        except ValueError:
            raise RuntimeError("invalid native response: " + text[:300])
        return result, now() - started, len(raw)



class CuaEngine:
    name = "cua"

    def __init__(self, c, pid, wid):
        self.c, self.pid, self.wid = c, pid, wid
        self.elements = []

    def snapshot(self):
        r = self.c.call("get_window_state", {"pid": self.pid, "window_id": self.wid, "include_screenshot": False, "full_output": True})
        s = cua_sc(r)
        if r.get("isError") or "_rpc_error" in r:
            raise RuntimeError(cua_text(r) or str(r))
        self.elements = s.get("elements") or md_rows(s.get("tree_markdown") or cua_text(r), s.get("snapshot_id"))
        self.last_snapshot = r
        return self.elements

    def act(self, action, element, escalate, text=""):
        base = {"pid": self.pid, "window_id": self.wid}
        tok = element.get("element_token")
        if not tok:
            raise RuntimeError("selected cua element has no token")
        if action == "click":
            tool, args = "click", {**base, "element_token": tok}
        elif action == "type":
            tool, args = "type_text", {**base, "element_token": tok, "text": text}
        elif action == "return":
            tool, args = "press_key", {**base, "element_token": tok, "key": "return"}
        elif action == "ctrl_a":
            tool, args = "hotkey", {**base, "element_token": tok, "keys": ["ctrl", "a"]}
        elif action == "scroll":
            tool, args = "scroll", {**base, "element_token": tok, "direction": "down", "amount": 3}
        elif action == "choose":
            tool, args = "set_value", {**base, "element_token": tok, "value": "Blue"}
        if escalate and tool in ("click", "type_text", "press_key", "hotkey", "scroll"):
            args["delivery_mode"] = "foreground"
        if "element_token" in args and not args["element_token"]:
            return {"ms": 0, "reported": "no_element", "detail": "selector found no element", "error": True}
        r = self.c.call(tool, args)
        self.last_response = r
        if "_rpc_error" in r:
            return {"ms": r["_ms"], "reported": "rpc_error", "detail": json.dumps(r["_rpc_error"])[:300], "error": True}
        s = cua_sc(r)
        err = bool(r.get("isError"))
        code = s.get("code") or (s["error"].get("code") if isinstance(s.get("error"), dict) else None)
        effect = s.get("effect")
        reported = effect or (("error:" + str(code)) if err else "ok(no effect field)")
        if err and effect:
            reported = f"{effect}(isError)"
        return {"ms": r["_ms"], "reported": reported, "error": err, "route": s.get("route"),
                "delivery": (s.get("delivery") or {}).get("mode") if isinstance(s.get("delivery"), dict) else s.get("delivery"),
                "code": code, "detail": (s.get("summary") or cua_text(r))[:300]}



class OrcaEngine:
    name = "orca"

    def __init__(self, o, pid):
        self.o, self.app = o, f"pid:{pid}"
        self.target = {}
        self.elements = []

    def snapshot(self):
        r, ms, n = self.o.op({"tool": "get_app_state", "app": self.app, "noScreenshot": True})
        if not r.get("ok"):
            raise RuntimeError("orca get_app_state: " + str(r.get("error"))[:300])
        snap = r["snapshot"]
        self.elements = snap.get("elements") or []
        # Mirror desktopActionWindowTarget: Windows targets by id, Linux by index.
        self.target = {"windowId": snap.get("windowId")} if snap.get("windowId") is not None else {"windowIndex": snap.get("windowIndex")}
        self.last_snapshot = snap
        return self.elements

    def _req(self, tool, element=None, escalate=False, **extra):
        req = {"tool": tool, "app": self.app, "element": element, "windowBounds": None, **self.target,
               "noScreenshot": True, "restoreWindow": bool(escalate)}
        req.update(extra)
        return req

    def act(self, action, el, escalate, text=""):
        if action == "click":
            req = self._req("click", el, escalate)
        elif action == "type":
            req = self._req("type_text", el, escalate, text=text)
        elif action == "return":
            req = self._req("press_key", el, escalate, key="return")
        elif action == "ctrl_a":
            req = self._req("hotkey", el, escalate, key="ctrl+a")
        elif action == "scroll":
            req = self._req("scroll", el, escalate, direction="down", pages=1)
        elif action == "choose":
            req = self._req("set_value", el, escalate, value="Blue")
        r, ms, _ = self.o.op(req)
        self.last_response = r
        return self._result(r, ms)

    def _result(self, r, ms):
        if not r.get("ok"):
            return {"ms": ms, "reported": "error", "error": True, "detail": str(r.get("error"))[:300]}
        a = r.get("action") or {}
        v = (a.get("verification") or {}).get("state")
        return {"ms": ms, "reported": v or "ok(no verification)", "error": False, "route": a.get("path"), "detail": json.dumps(a)[:300]}
