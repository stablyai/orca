"""Windows host observation (foreground, z-order, cursor, clipboard) and the user's typer, via user32."""
import ctypes
import ctypes.wintypes as W
import threading
import time

try:
    ctypes.windll.shcore.SetProcessDpiAwareness(2)
except Exception:
    ctypes.windll.user32.SetProcessDPIAware()

u = ctypes.WinDLL("user32", use_last_error=True)
k32 = ctypes.WinDLL("kernel32", use_last_error=True)

GW_HWNDPREV = 3
WM_GETTEXT, WM_GETTEXTLENGTH, WM_SETTEXT = 0x000D, 0x000E, 0x000C
EM_GETSEL, EM_SETSEL, EM_GETFIRSTVISIBLELINE, EM_LINESCROLL = 0x00B0, 0x00B1, 0x00CE, 0x00B6
WM_VSCROLL, SB_TOP = 0x0115, 6
SMTO_ABORTIFHUNG = 0x2
SWP_NOACTIVATE, SWP_NOZORDER = 0x0010, 0x0004
SPI_GETFOREGROUNDLOCKTIMEOUT = 0x2000

ULONG_PTR = ctypes.c_size_t


class KEYBDINPUT(ctypes.Structure):
    _fields_ = [("wVk", W.WORD), ("wScan", W.WORD), ("dwFlags", W.DWORD), ("time", W.DWORD), ("dwExtraInfo", ULONG_PTR)]


class MOUSEINPUT(ctypes.Structure):
    _fields_ = [("dx", W.LONG), ("dy", W.LONG), ("mouseData", W.DWORD), ("dwFlags", W.DWORD), ("time", W.DWORD), ("dwExtraInfo", ULONG_PTR)]


class _U(ctypes.Union):
    _fields_ = [("ki", KEYBDINPUT), ("mi", MOUSEINPUT)]


class INPUT(ctypes.Structure):
    _fields_ = [("type", W.DWORD), ("u", _U)]


WNDENUMPROC = ctypes.WINFUNCTYPE(W.BOOL, W.HWND, W.LPARAM)
u.EnumWindows.argtypes = [WNDENUMPROC, W.LPARAM]
u.GetWindowThreadProcessId.argtypes = [W.HWND, ctypes.POINTER(W.DWORD)]
u.GetWindowThreadProcessId.restype = W.DWORD
u.GetForegroundWindow.restype = W.HWND
u.GetWindow.restype = W.HWND
u.GetWindow.argtypes = [W.HWND, W.UINT]
u.FindWindowExW.restype = W.HWND
u.FindWindowExW.argtypes = [W.HWND, W.HWND, W.LPCWSTR, W.LPCWSTR]
u.SendMessageTimeoutW.argtypes = [W.HWND, W.UINT, W.WPARAM, W.LPARAM, W.UINT, W.UINT, ctypes.POINTER(ULONG_PTR)]
u.SendMessageTimeoutW.restype = W.LPARAM
u.SetWindowPos.argtypes = [W.HWND, W.HWND, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int, W.UINT]
u.SendInput.argtypes = [W.UINT, ctypes.POINTER(INPUT), ctypes.c_int]
u.AttachThreadInput.argtypes = [W.DWORD, W.DWORD, W.BOOL]
u.SetForegroundWindow.argtypes = [W.HWND]
u.BringWindowToTop.argtypes = [W.HWND]
u.IsWindowVisible.argtypes = [W.HWND]
u.GetClassNameW.argtypes = [W.HWND, W.LPWSTR, ctypes.c_int]
u.GetWindowTextW.argtypes = [W.HWND, W.LPWSTR, ctypes.c_int]
u.GetWindowRect.argtypes = [W.HWND, ctypes.POINTER(W.RECT)]


def hval(h):
    return int(h or 0)


def pid_of(hwnd):
    p = W.DWORD(0)
    u.GetWindowThreadProcessId(hwnd, ctypes.byref(p))
    return p.value


def title_of(hwnd):
    b = ctypes.create_unicode_buffer(512)
    u.GetWindowTextW(hwnd, b, 512)
    return b.value


def class_of(hwnd):
    b = ctypes.create_unicode_buffer(256)
    u.GetClassNameW(hwnd, b, 256)
    return b.value


def top_windows():
    out = []

    def cb(h, _l):
        out.append(hval(h))
        return True

    u.EnumWindows(WNDENUMPROC(cb), 0)
    return out


def find_window(pid=None, title=None, cls=None, visible=True):
    for h in top_windows():
        if visible and not u.IsWindowVisible(h):
            continue
        if pid is not None and pid_of(h) != pid:
            continue
        if title is not None and title not in title_of(h):
            continue
        if cls is not None and class_of(h) != cls:
            continue
        return h
    return 0


def describe(h):
    r = W.RECT()
    u.GetWindowRect(h, ctypes.byref(r))
    return {"hwnd": h, "pid": pid_of(h), "title": title_of(h), "class": class_of(h), "rect": [r.left, r.top, r.right, r.bottom]}


def foreground():
    return hval(u.GetForegroundWindow())


def cursor():
    p = W.POINT()
    u.GetCursorPos(ctypes.byref(p))
    return (p.x, p.y)


def clip_seq():
    return u.GetClipboardSequenceNumber()


def lock_timeout():
    v = W.DWORD(0)
    u.SystemParametersInfoW(SPI_GETFOREGROUNDLOCKTIMEOUT, 0, ctypes.byref(v), 0)
    return v.value


def session_id():
    s = W.DWORD(0)
    k32.ProcessIdToSessionId(k32.GetCurrentProcessId(), ctypes.byref(s))
    return s.value


def owned_above(sentinel, target_pid, limit=2000):
    """True when a visible top-level window of target_pid sits above the sentinel in z-order."""
    h = u.GetWindow(sentinel, GW_HWNDPREV)
    n = 0
    while h and n < limit:
        if u.IsWindowVisible(h) and pid_of(h) == target_pid:
            return True
        h = u.GetWindow(h, GW_HWNDPREV)
        n += 1
    return False


def place(hwnd, x, y, w, h):
    u.SetWindowPos(hwnd, 0, x, y, w, h, SWP_NOACTIVATE | SWP_NOZORDER)


def force_foreground(hwnd):
    """Bench setup only: re-front the sentinel between trials (AttachThreadInput, no keystrokes)."""
    if foreground() == hwnd:
        return True
    cur = k32.GetCurrentThreadId()
    fg = foreground()
    threads = {u.GetWindowThreadProcessId(fg, None) if fg else 0, u.GetWindowThreadProcessId(hwnd, None)} - {0, cur}
    attached = [t for t in threads if u.AttachThreadInput(cur, t, True)]
    u.BringWindowToTop(hwnd)
    u.SetForegroundWindow(hwnd)
    for t in attached:
        u.AttachThreadInput(cur, t, False)
    for _ in range(25):
        if foreground() == hwnd:
            return True
        time.sleep(0.02)
    return foreground() == hwnd


def send(hwnd, msg, wp=0, lp=0, timeout=1000):
    res = ULONG_PTR(0)
    ok = u.SendMessageTimeoutW(hwnd, msg, wp, lp, SMTO_ABORTIFHUNG, timeout, ctypes.byref(res))
    return res.value if ok else None


def edit_child(top):
    """Notepad's editor: classic Edit, or RichEditD2DPT in the WinUI Notepad."""
    for cls in ("Edit", "RichEditD2DPT"):
        h = hval(u.FindWindowExW(top, None, cls, None))
        if h:
            return h
    stack = [top]
    while stack:
        p = stack.pop()
        c = hval(u.FindWindowExW(p, None, None, None))
        while c:
            if class_of(c) in ("Edit", "RichEditD2DPT"):
                return c
            stack.append(c)
            c = hval(u.FindWindowExW(p, c, None, None))
    return 0


def edit_text(h):
    n = send(h, WM_GETTEXTLENGTH) or 0
    buf = ctypes.create_unicode_buffer(n + 2)
    send(h, WM_GETTEXT, n + 1, ctypes.addressof(buf))
    return buf.value


def edit_set(h, text, caret=None):
    buf = ctypes.create_unicode_buffer(text)
    send(h, WM_SETTEXT, 0, ctypes.addressof(buf))
    c = len(text) if caret is None else caret
    send(h, EM_SETSEL, c, c)
    send(h, WM_VSCROLL, SB_TOP, 0)


def edit_sel(h):
    v = send(h, EM_GETSEL) or 0
    return (v & 0xFFFF, (v >> 16) & 0xFFFF)


def edit_first_line(h):
    return send(h, EM_GETFIRSTVISIBLELINE) or 0


class Typer:
    """Simulated user: one 'q' every 200 ms through SendInput (goes to whatever has keyboard focus)."""

    def __init__(self, period=0.2):
        self.period = period
        self.sent = 0
        self.run = False
        self.vk = 0x51
        self.scan = u.MapVirtualKeyW(self.vk, 0)

    def _key(self, up):
        i = INPUT(type=1)
        i.u.ki = KEYBDINPUT(self.vk, self.scan, 0x0002 if up else 0, 0, 0)
        return i

    def _loop(self):
        while self.run:
            arr = (INPUT * 2)(self._key(False), self._key(True))
            if u.SendInput(2, arr, ctypes.sizeof(INPUT)) == 2:
                self.sent += 1
            time.sleep(self.period)

    def start(self):
        self.run = True
        self.thread = threading.Thread(target=self._loop, daemon=True)
        self.thread.start()

    def stop(self):
        self.run = False
        self.thread.join()
        time.sleep(0.1)


class Sampler:
    """Samples every ~4 ms: foreground window, target-above-sentinel, cursor, clipboard sequence."""

    def __init__(self, sentinel, target, target_pid, own_pids=()):
        self.s, self.t, self.tpid = sentinel, target, target_pid
        self.own = set(own_pids)

    def _sample(self):
        fg = foreground()
        return (time.perf_counter(), fg, pid_of(fg) if fg else 0, owned_above(self.s, self.tpid), cursor(), clip_seq())

    def start(self):
        self.base = self._sample()
        self.samples = [self.base]
        self.error = None
        self.run = True
        self.th = threading.Thread(target=self._loop, daemon=True)
        self.th.start()

    def _loop(self):
        try:
            while self.run:
                self.samples.append(self._sample())
                time.sleep(0.004)
        except Exception as error:
            self.error = error

    def stop(self):
        self.run = False
        self.th.join()
        if self.error:
            raise RuntimeError("observer sampling failed") from self.error
        self.samples.append(self._sample())
        b = self.base
        ss = self.samples
        lost = [x for x in ss if x[1] != self.s]
        return {
            "sentinel_lost_focus": bool(lost),
            "lost_ms": round(_dur(ss, lambda x: x[1] != self.s) * 1000, 1),
            "target_activated": any(x[2] == self.tpid for x in ss),
            "target_raised": any(x[3] for x in ss),
            "pointer_moved": any(abs(x[4][0] - b[4][0]) > 1 or abs(x[4][1] - b[4][1]) > 1 for x in ss),
            "pointer_end": list(ss[-1][4]), "pointer_start": list(b[4]),
            "clipboard_changed": any(x[5] != b[5] for x in ss),
            "fg_pids": sorted({x[2] for x in ss}),
            "n_samples": len(ss),
        }


def _dur(ss, pred):
    return sum(b[0] - a[0] for a, b in zip(ss, ss[1:]) if pred(a))
