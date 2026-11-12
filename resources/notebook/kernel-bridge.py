"""Runs one Jupyter kernel for Orca in the interpreter that launched this script.

Protocol: one JSON object per line. Orca writes {"op": "execute", "code": ...} and
{"op": "interrupt"} to stdin; this writes {"type": ...} frames to stdout. Closing
stdin shuts the kernel down, so the kernel never outlives Orca. When the kernel
dies this process exits, so its exit is the one death signal Orca watches.
"""

import json
import os
import queue
import sys
import threading
import time

# Frames own the real stdout; anything else writing to fd 1 (imports, C code) lands on stderr.
_frames = os.fdopen(os.dup(1), "wb", buffering=0)
os.dup2(2, 1)
sys.stdout = sys.stderr
_frames_lock = threading.Lock()

OUTPUT_TYPES = {
    "stream",
    "display_data",
    "execute_result",
    "update_display_data",
    "clear_output",
    "error",
}


def send(frame):
    line = (json.dumps(frame) + "\n").encode("utf-8")
    with _frames_lock:
        _frames.write(line)


def externally_managed():
    """PEP 668: pip refuses to install into this interpreter outside a virtual environment."""
    import sysconfig

    if sys.prefix != getattr(sys, "base_prefix", sys.prefix):
        return False
    return os.path.isfile(os.path.join(sysconfig.get_path("stdlib"), "EXTERNALLY-MANAGED"))


try:
    import ipykernel  # noqa: F401
    from jupyter_client.kernelspec import KernelSpec
    from jupyter_client.manager import KernelManager
except ImportError:
    send({"type": "missing", "externallyManaged": externally_managed()})
    sys.exit(0)


def forward(msg):
    if msg["header"]["msg_type"] in OUTPUT_TYPES:
        send({"type": msg["header"]["msg_type"], "content": msg["content"]})


def execute_all(client, codes):
    while True:
        code = codes.get()
        # allow_stdin=False: input() raises a clear error instead of reading Orca's command pipe.
        reply = client.execute_interactive(code, allow_stdin=False, output_hook=forward)
        content = reply["content"]
        send(
            {
                "type": "done",
                "status": content.get("status"),
                "execution_count": content.get("execution_count"),
            }
        )


def exit_when_dead(manager):
    while manager.is_alive():
        time.sleep(0.5)
    # Exit even if cleanup fails (cleanup_resources is missing before jupyter_client 6.1.5).
    try:
        manager.cleanup_resources()
    finally:
        os._exit(1)


def main():
    manager = KernelManager()
    # Why: a user-level "python3" kernelspec may point at another interpreter; run this one.
    manager._kernel_spec = KernelSpec(
        argv=[sys.executable, "-m", "ipykernel_launcher", "-f", "{connection_file}"],
        display_name="Python",
        language="python",
    )
    manager.start_kernel()
    client = manager.client()
    client.start_channels()
    try:
        client.wait_for_ready(timeout=60)
    except RuntimeError:
        manager.shutdown_kernel(now=True)
        sys.exit(1)

    codes = queue.Queue()
    threading.Thread(target=execute_all, args=(client, codes), daemon=True).start()
    threading.Thread(target=exit_when_dead, args=(manager,), daemon=True).start()
    send({"type": "ready"})

    for line in sys.stdin.buffer:
        command = json.loads(line)
        if command["op"] == "execute":
            codes.put(command["code"])
        elif command["op"] == "interrupt":
            manager.interrupt_kernel()
    manager.shutdown_kernel(now=True)
    os._exit(0)


main()
