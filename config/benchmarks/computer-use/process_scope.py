"""Contain each trial's process tree, including operations that time out."""
import os
import signal
import subprocess
import sys
import tempfile

WIN = sys.platform == "win32"

if WIN:
    import ctypes
    from ctypes import wintypes as W

    class BasicLimit(ctypes.Structure):
        _fields_ = [("processTime", ctypes.c_longlong), ("jobTime", ctypes.c_longlong),
                    ("flags", W.DWORD), ("minWorkingSet", ctypes.c_size_t),
                    ("maxWorkingSet", ctypes.c_size_t), ("activeProcesses", W.DWORD),
                    ("affinity", ctypes.c_size_t), ("priority", W.DWORD), ("scheduling", W.DWORD)]

    class IoCounters(ctypes.Structure):
        _fields_ = [(name, ctypes.c_ulonglong) for name in
                    ("readOps", "writeOps", "otherOps", "readBytes", "writeBytes", "otherBytes")]

    class ExtendedLimit(ctypes.Structure):
        _fields_ = [("basic", BasicLimit), ("io", IoCounters), ("processMemory", ctypes.c_size_t),
                    ("jobMemory", ctypes.c_size_t), ("peakProcess", ctypes.c_size_t), ("peakJob", ctypes.c_size_t)]

    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.CreateJobObjectW.argtypes = [ctypes.c_void_p, W.LPCWSTR]
    kernel.CreateJobObjectW.restype = W.HANDLE
    kernel.SetInformationJobObject.argtypes = [W.HANDLE, ctypes.c_int, ctypes.c_void_p, W.DWORD]
    kernel.AssignProcessToJobObject.argtypes = [W.HANDLE, W.HANDLE]
    kernel.TerminateJobObject.argtypes = [W.HANDLE, W.UINT]
    kernel.CloseHandle.argtypes = [W.HANDLE]
    kernel.QueryInformationJobObject.argtypes = [W.HANDLE, ctypes.c_int, ctypes.c_void_p, W.DWORD, ctypes.c_void_p]
    nt = ctypes.WinDLL("ntdll")
    nt.NtResumeProcess.argtypes = [W.HANDLE]
    nt.NtResumeProcess.restype = ctypes.c_long

    class Accounting(ctypes.Structure):
        _fields_ = [("user", ctypes.c_longlong), ("kernel", ctypes.c_longlong),
                    ("periodUser", ctypes.c_longlong), ("periodKernel", ctypes.c_longlong),
                    ("faults", W.DWORD), ("total", W.DWORD), ("active", W.DWORD), ("terminated", W.DWORD)]


class ProcessScope:
    def __init__(self, directory=None):
        self.directory = directory or tempfile.mkdtemp(prefix="orca-computer-trial-")
        self.procs = []
        self.job = None
        if WIN:
            self.job = kernel.CreateJobObjectW(None, None)
            limits = ExtendedLimit()
            limits.basic.flags = 0x2000  # Closing the job kills descendants too.
            if not self.job or not kernel.SetInformationJobObject(self.job, 9, ctypes.byref(limits), ctypes.sizeof(limits)):
                raise ctypes.WinError(ctypes.get_last_error())

    def spawn(self, args, hidden=False, **kwargs):
        if WIN:
            kwargs["creationflags"] = 0x4 | (0x08000000 if hidden else 0)
        else:
            kwargs["start_new_session"] = True
        proc = subprocess.Popen(args, **kwargs)
        self.procs.append(proc)
        if WIN:
            # Suspend until assigned so children cannot escape the trial job.
            if not kernel.AssignProcessToJobObject(self.job, int(proc._handle)):
                proc.kill()
                proc.wait()
                raise ctypes.WinError(ctypes.get_last_error())
            if nt.NtResumeProcess(int(proc._handle)) != 0:
                raise RuntimeError("failed to resume contained process")
        return proc

    def close(self):
        import time
        if WIN and self.job:
            if not kernel.TerminateJobObject(self.job, 1):
                raise ctypes.WinError(ctypes.get_last_error())
            end = time.monotonic() + 10
            while True:
                info = Accounting()
                if not kernel.QueryInformationJobObject(self.job, 1, ctypes.byref(info), ctypes.sizeof(info), None):
                    raise ctypes.WinError(ctypes.get_last_error())
                if info.active == 0:
                    break
                if time.monotonic() >= end:
                    raise TimeoutError("trial job did not become quiescent")
                time.sleep(0.02)
            kernel.CloseHandle(self.job)
            self.job = None
        elif not WIN:
            for proc in self.procs:
                try:
                    os.killpg(proc.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
        for proc in self.procs:
            proc.wait(timeout=10)
            for stream in (proc.stdin, proc.stdout):
                if stream:
                    stream.close()
        self.procs.clear()
