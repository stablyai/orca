#!/usr/bin/env python3
"""GTK3 target for the cua-vs-Orca background bench. Writes state.json every 30 ms; obeys cmd."""
import json
import os
import sys

if os.environ.get("ORCA_COMPUTER_BENCH_ISOLATED") != "1" or os.environ.get("GITHUB_ACTIONS") != "true":
    raise SystemExit("fixture requires isolated CI desktop")

import gi

gi.require_version("Gtk", "3.0")
from gi.repository import Gdk, GLib, Gtk  # noqa: E402

state_dir = sys.argv[1]
STATE = os.path.join(state_dir, "state.json")
CMD = os.path.join(state_dir, "cmd")
instance = os.environ["BENCH_INSTANCE"]
ack = None
sequence = 0
s = {"count": 0, "returns": 0, "submittedText": None, "clickedColor": None, "menuHits": 0, "last": None}


def named(widget, name):
    widget.get_accessible().set_name(name)
    return widget


Gtk.Settings.get_default().set_property("gtk-entry-select-on-focus", False)
win = Gtk.Window(title="BenchTarget")
win.set_default_size(760, 560)
win.move(60, 60)
win.connect("destroy", Gtk.main_quit)
accel = Gtk.AccelGroup()
win.add_accel_group(accel)
box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=6)
win.add(box)

menubar = Gtk.MenuBar()
edit = Gtk.MenuItem(label="Edit")
sub = Gtk.Menu()
sub.set_accel_group(accel)
bump = Gtk.MenuItem(label="Bump")
bump.add_accelerator("activate", accel, ord("b"), Gdk.ModifierType.CONTROL_MASK, Gtk.AccelFlags.VISIBLE)
bump.connect("activate", lambda _w: s.__setitem__("menuHits", s["menuHits"] + 1))
sub.append(bump)
edit.set_submenu(sub)
menubar.append(edit)
box.pack_start(menubar, False, False, 0)

def increment(_button):
    s["count"] += 1
    s["clickedColor"] = combo.get_active_text()


def submit(entry):
    s["returns"] += 1
    s["submittedText"] = entry.get_text()


button = Gtk.Button(label="Increment")
button.connect("clicked", increment)
check = Gtk.CheckButton(label="Check me")
field = named(Gtk.Entry(), "field")
field.connect("activate", submit)
decoy = named(Gtk.Entry(), "decoy")
combo = named(Gtk.ComboBoxText(), "Color")
for item in ("Red", "Green", "Blue"):
    combo.append_text(item)
combo.set_active(0)
scroll = named(Gtk.ScrolledWindow(), "list")
scroll.set_size_request(300, 250)
rows = Gtk.ListBox()
for i in range(1, 301):
    rows.add(Gtk.Label(label=f"Row {i}"))
scroll.add(rows)
for widget in (button, check, field, decoy, combo):
    box.pack_start(widget, False, False, 0)
box.pack_start(scroll, True, True, 0)


def command(c):
    global ack
    if c["instance"] != instance:
        return
    s["count"] = s["returns"] = s["menuHits"] = 0
    s["submittedText"] = s["clickedColor"] = None
    check.set_active(False)
    sub.popdown()
    combo.set_active(0)
    scroll.get_vadjustment().set_value(0)
    field.set_text("hello" if c["task"] == "replace_submit" else "")
    field.set_position(len(field.get_text()))
    field.select_region(len(field.get_text()), len(field.get_text()))
    decoy.set_text("untouched")
    decoy.set_position(9)
    decoy.select_region(9, 9)
    win.set_focus(decoy if c["task"] == "targeted_type" else field)
    ack = c["nonce"]


def tick():
    global sequence
    sequence += 1
    try:
        with open(CMD) as f:
            c = f.read().strip()
        if c:
            open(CMD, "w").close()
            command(json.loads(c))
    except (OSError, ValueError):
        pass
    bounds = field.get_selection_bounds()
    sel = list(bounds) if bounds else [field.get_position(), field.get_position()]
    state = {
        "instance": instance, "ack": ack, "seq": sequence, "decoyText": decoy.get_text(),
        "logicalFocus": "field" if win.get_focus() is field else "decoy" if win.get_focus() is decoy else "other",
        "count": s["count"], "check": check.get_active(), "text": field.get_text(), "returns": s["returns"],
        "submittedText": s["submittedText"], "clickedColor": s["clickedColor"],
        "selStart": sel[0], "selLen": sel[1] - sel[0], "combo": combo.get_active_text(),
        "top": scroll.get_vadjustment().get_value(), "menuHits": s["menuHits"], "dropOpen": sub.get_visible(),
        "activeForm": win.is_active(), "fieldFocused": win.get_focus() is field, "pid": os.getpid(),
    }
    data = json.dumps(state)
    if data != s["last"]:
        tmp = STATE + ".tmp"
        with open(tmp, "w") as f:
            f.write(data)
        os.replace(tmp, STATE)
        s["last"] = data
    return True


win.show_all()
win.set_focus(field)
GLib.timeout_add(30, tick)
Gtk.main()
