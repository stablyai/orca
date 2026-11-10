"""X11 host observation (active window, input focus, stacking, pointer, selections) and the user's typer."""
import ctypes
import ctypes.util
import subprocess
import threading
import time

X = ctypes.cdll.LoadLibrary(ctypes.util.find_library("X11") or "libX11.so.6")
XT = ctypes.cdll.LoadLibrary(ctypes.util.find_library("Xtst") or "libXtst.so.6")
Window = ctypes.c_ulong
Atom = ctypes.c_ulong
P = ctypes.POINTER
vp = ctypes.c_void_p

X.XOpenDisplay.restype = vp
X.XOpenDisplay.argtypes = [ctypes.c_char_p]
X.XInitThreads.restype = ctypes.c_int
X.XDefaultRootWindow.restype = Window
X.XDefaultRootWindow.argtypes = [vp]
X.XInternAtom.restype = Atom
X.XInternAtom.argtypes = [vp, ctypes.c_char_p, ctypes.c_int]
X.XGetWindowProperty.argtypes = [vp, Window, Atom, ctypes.c_long, ctypes.c_long, ctypes.c_int, Atom,
                                 P(Atom), P(ctypes.c_int), P(ctypes.c_ulong), P(ctypes.c_ulong), P(vp)]
X.XFree.argtypes = [vp]
X.XGetInputFocus.argtypes = [vp, P(Window), P(ctypes.c_int)]
X.XQueryPointer.argtypes = [vp, Window, P(Window), P(Window), P(ctypes.c_int), P(ctypes.c_int),
                            P(ctypes.c_int), P(ctypes.c_int), P(ctypes.c_uint)]
X.XGetSelectionOwner.restype = Window
X.XGetSelectionOwner.argtypes = [vp, Atom]
X.XQueryTree.argtypes = [vp, Window, P(Window), P(Window), P(P(Window)), P(ctypes.c_uint)]
X.XStringToKeysym.restype = ctypes.c_ulong
X.XStringToKeysym.argtypes = [ctypes.c_char_p]
X.XKeysymToKeycode.restype = ctypes.c_ubyte
X.XKeysymToKeycode.argtypes = [vp, ctypes.c_ulong]
X.XFlush.argtypes = [vp]
X.XCloseDisplay.argtypes = [vp]
XT.XTestFakeKeyEvent.argtypes = [vp, ctypes.c_uint, ctypes.c_int, ctypes.c_ulong]

X.XInitThreads()
ERRH = ctypes.CFUNCTYPE(ctypes.c_int, vp, vp)(lambda _d, _e: 0)
X.XSetErrorHandler(ERRH)


class Display:
    def __init__(self):
        self.d = X.XOpenDisplay(None)
        if not self.d:
            raise RuntimeError("cannot open X display")
        self.root = X.XDefaultRootWindow(self.d)
        self.atoms = {}

    def atom(self, name):
        if name not in self.atoms:
            self.atoms[name] = X.XInternAtom(self.d, name.encode(), 0)
        return self.atoms[name]

    def prop_longs(self, win, name):
        at, fmt, n, after, data = Atom(), ctypes.c_int(), ctypes.c_ulong(), ctypes.c_ulong(), vp()
        rc = X.XGetWindowProperty(self.d, win, self.atom(name), 0, 4096, 0, 0, ctypes.byref(at), ctypes.byref(fmt),
                                  ctypes.byref(n), ctypes.byref(after), ctypes.byref(data))
        if rc != 0 or not data.value:
            return []
        try:
            if fmt.value != 32:
                return []
            arr = ctypes.cast(data, P(ctypes.c_ulong))
            return [arr[i] for i in range(n.value)]
        finally:
            X.XFree(data)

    def active(self):
        v = self.prop_longs(self.root, "_NET_ACTIVE_WINDOW")
        return v[0] if v else 0

    def stacking(self):
        return self.prop_longs(self.root, "_NET_CLIENT_LIST_STACKING")

    def clients(self):
        return self.prop_longs(self.root, "_NET_CLIENT_LIST")

    def pid_of(self, w):
        v = self.prop_longs(w, "_NET_WM_PID")
        return v[0] if v else 0

    def focus(self):
        w, r = Window(), ctypes.c_int()
        X.XGetInputFocus(self.d, ctypes.byref(w), ctypes.byref(r))
        return w.value

    def pointer(self):
        r, c = Window(), Window()
        rx, ry, wx, wy = ctypes.c_int(), ctypes.c_int(), ctypes.c_int(), ctypes.c_int()
        m = ctypes.c_uint()
        X.XQueryPointer(self.d, self.root, ctypes.byref(r), ctypes.byref(c), ctypes.byref(rx), ctypes.byref(ry),
                        ctypes.byref(wx), ctypes.byref(wy), ctypes.byref(m))
        return (rx.value, ry.value)

    def owner(self, sel):
        return X.XGetSelectionOwner(self.d, self.atom(sel))

    def descendants(self, w):
        out, stack = {w}, [w]
        while stack:
            p = stack.pop()
            r, par, kids, n = Window(), Window(), P(Window)(), ctypes.c_uint()
            if not X.XQueryTree(self.d, p, ctypes.byref(r), ctypes.byref(par), ctypes.byref(kids), ctypes.byref(n)):
                continue
            for i in range(n.value):
                out.add(kids[i])
                stack.append(kids[i])
            if kids:
                X.XFree(kids)
        return out

    def windows_of(self, pid):
        return [w for w in self.clients() if self.pid_of(w) == pid]

    def close(self):
        if self.d:
            X.XCloseDisplay(self.d)
            self.d = None


_MAIN = []


def main_display():
    """One connection for the bench's main thread; Xvfb allows only ~256 clients."""
    if not _MAIN:
        _MAIN.append(Display())
    return _MAIN[0]


def find_client(pid, title=None):
    """Managed client window of pid (by _NET_WM_PID), else by exact title (Tk may omit _NET_WM_PID)."""
    d = main_display()
    ws = d.windows_of(pid)
    if ws:
        return ws[0]
    if title:
        clients = set(d.clients())
        out = xdotool("search", "--name", f"^{title}$").stdout.split()
        for w in out:
            if int(w) in clients:
                return int(w)
    return 0


def xdotool(*args):
    return subprocess.run(["xdotool", *map(str, args)], capture_output=True, text=True, timeout=10)


def window_name(w):
    return xdotool("getwindowname", w).stdout.strip()


def place(w, x, y, width, height):
    xdotool("windowsize", w, width, height)
    xdotool("windowmove", w, x, y)


def force_foreground(w):
    """Bench setup only: re-front the sentinel between trials."""
    d = main_display()
    if d.active() == w:
        return True
    xdotool("windowactivate", "--sync", w)
    xdotool("windowraise", w)
    for _ in range(25):
        if d.active() == w:
            return True
        time.sleep(0.02)
    return d.active() == w


class Typer:
    """Simulated user: one 'q' every 200 ms through XTest (goes to the X input focus)."""

    def __init__(self, period=0.2):
        self.period = period
        self.sent = 0
        self.run = False

    def _loop(self):
        d = Display()
        kc = X.XKeysymToKeycode(d.d, X.XStringToKeysym(b"q"))
        while self.run:
            XT.XTestFakeKeyEvent(d.d, kc, 1, 0)
            XT.XTestFakeKeyEvent(d.d, kc, 0, 0)
            X.XFlush(d.d)
            self.sent += 1
            time.sleep(self.period)
        d.close()

    def start(self):
        self.run = True
        self.thread = threading.Thread(target=self._loop, daemon=True)
        self.thread.start()

    def stop(self):
        self.run = False
        self.thread.join()
        time.sleep(0.1)


class Sampler:
    """Samples every ~4 ms: active window, input focus, stacking, pointer, CLIPBOARD/PRIMARY owners."""

    def __init__(self, sentinel, target, target_pid, own_pids=()):
        self.s, self.t, self.tpid = sentinel, target, target_pid
        self.s_set = main_display().descendants(sentinel)

    def _sample(self, d):
        st = d.stacking()
        act = d.active()
        foc = d.focus()
        tw = set(d.windows_of(self.tpid)) or {self.t}
        raised = False
        if self.s in st:
            si = st.index(self.s)
            raised = any(st.index(w) > si for w in tw if w in st)
        return (time.perf_counter(), act, foc, raised, d.pointer(), d.owner("CLIPBOARD"), d.owner("PRIMARY"), act in tw)

    def start(self):
        self.d = main_display()
        self.base = self._sample(self.d)
        self.samples = [self.base]
        self.error = None
        self.run = True
        self.th = threading.Thread(target=self._loop, daemon=True)
        self.th.start()

    def _loop(self):
        d = Display()
        try:
            while self.run:
                self.samples.append(self._sample(d))
                time.sleep(0.004)
        except Exception as error:
            self.error = error
        finally:
            d.close()

    def stop(self):
        self.run = False
        self.th.join()
        if self.error:
            raise RuntimeError("observer sampling failed") from self.error
        self.samples.append(self._sample(self.d))
        b, ss = self.base, self.samples
        lost = lambda x: x[1] != self.s or (x[2] not in self.s_set)
        return {
            "sentinel_lost_focus": any(lost(x) for x in ss),
            "lost_ms": round(sum(q[0] - p[0] for p, q in zip(ss, ss[1:]) if lost(p)) * 1000, 1),
            "target_activated": any(x[7] for x in ss),
            "target_raised": any(x[3] for x in ss),
            "pointer_moved": any(abs(x[4][0] - b[4][0]) > 1 or abs(x[4][1] - b[4][1]) > 1 for x in ss),
            "pointer_end": list(ss[-1][4]), "pointer_start": list(b[4]),
            "clipboard_changed": any(x[5] != b[5] for x in ss),
            "primary_changed": any(x[6] != b[6] for x in ss),
            "focus_windows": sorted({hex(x[2]) for x in ss})[:6],
            "n_samples": len(ss),
        }
