"""The "user": a frontmost Tk window that receives one 'q' every 200 ms from the bench typer.

Writes cumulative counts to <out>: q = 'q' keystrokes that reached it, other = any other
characters (agent input that leaked into the user's window).
"""
import json
import os
import sys

if os.environ.get("ORCA_COMPUTER_BENCH_ISOLATED") != "1" or os.environ.get("GITHUB_ACTIONS") != "true":
    raise SystemExit("fixture requires isolated CI desktop")
import tkinter as tk

out, geometry = sys.argv[1], sys.argv[2]
root = tk.Tk()
root.title("BenchSentinel")
root.geometry(geometry)
text = tk.Text(root, font=("Courier", 10))
text.pack(fill="both", expand=True)
base = {"q": 0, "other": 0}
ptr = {"clicks": 0, "wheels": 0}
root.bind_all("<ButtonPress>", lambda e: ptr.__setitem__("wheels" if e.num in (4, 5) else "clicks", ptr["wheels" if e.num in (4, 5) else "clicks"] + 1))
root.bind_all("<MouseWheel>", lambda e: ptr.__setitem__("wheels", ptr["wheels"] + 1))
last = [None]


def key(event):
    if event.char == 'q':
        base['q'] += 1
    elif event.char:
        base['other'] += 1


root.bind_all('<KeyPress>', key)


def tick():
    try:
        focus = str(root.focus_get())
    except Exception:
        focus = "?"
    data = json.dumps({"q": base["q"], "other": base["other"], "focus": focus, "pid": os.getpid(), **ptr})
    if data != last[0]:
        tmp = out + ".tmp"
        try:
            with open(tmp, "w") as f:
                f.write(data)
            os.replace(tmp, out)
            last[0] = data
        except OSError:
            pass
    root.after(20, tick)


root.after(100, lambda: (root.lift(), root.focus_force(), text.focus_set()))
root.after(20, tick)
root.mainloop()
