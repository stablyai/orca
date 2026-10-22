# AppImage extraction cache

Linux AppImage builds extract their payload once into `$XDG_CACHE_HOME/orca/appimage` (default
`~/.cache/orca/appimage`) so the CLI, `orca serve` and anything they start can run from a copy that
does not vanish when the AppImage's FUSE mount does.

## Layout

```
<cache>/launcher/orca-ide            stable wrapper; execs launcher/installed
<cache>/launcher/installed           symlink to <ns>/<generation>/resources/bin/orca-ide
<cache>/<ns>/<generation>/           one extracted payload ("generation")
<cache>/leases/<ns>.<gen>.<pid>.<starttime>.json
```

- `<generation>` is keyed by the AppImage file's identity (device, inode, size, mtime).
- `<ns>` is keyed by the AppImage path **and a layout version**. Builds before generation leases used
  `sha256(path)` alone. Those builds prune every generation in that directory except their own, so new
  builds extract into a directory they never scan. New builds still reclaim idle generations left in the
  old directory for the same path.

## When a generation may be deleted

A pruner deletes a generation only when all of these hold. Every pruner runs under the registration
lock (`withAppImageRegistrationLock`).

1. It is not the generation the pruner keeps, and `installed` does not point at it.
2. No process of this user has its executable in it, according to `/proc/<pid>/exe`.
3. No lease names it and a live process. A lease records the pid, the Linux start ticks and the boot
   id. A different start time means a recycled pid, and a different boot id means a reboot. Both make
   the lease stale, and the pruner deletes it.

If `/proc` or a lease holder cannot be read, the generation is kept. A desktop, `serve` or daemon
process that runs from a generation writes its own lease at startup.

## Remaining window: rollback

Running a pre-lease build again at the same AppImage path brings back its pruner. It scans only the
old directory, so new generations are safe from it. Generations in the old directory, which only
pre-lease builds extract, stay as exposed as they were before this change.

One gap is accepted. A process that `exec`s from a generation just as `installed` is republished and a
pruner runs may lose its copy before `/proc` shows it. `installed` and the pruner's own generation are
never deleted, so only a launch in that instant is exposed.

## The desktop terminal daemon

AppImage builds carry the pinned Node at `resources/node-runtime/bin/node`. deb and rpm drop that file
at packaging time. When a window starts a terminal daemon, it tries these in order:

1. **The extracted copy.** The bundled Node in the generation for the file now at `$APPIMAGE` runs that
   generation's `daemon-entry.js`. It is used only when the generation is complete, has the Node and the
   entry, and its stamped version equals the running app's. Nothing it runs from is on a FUSE mount. Its
   executable keeps the generation `live` for pruners, and it writes a lease at startup.
2. **The AppImage's own mount.** `$APPIMAGE -e` starts the daemon on Electron (#18200).
3. **The window's mount.** This is the original launch.

The desktop never extracts a generation itself; CLI registration and `orca serve` do. Each launch that
cannot use rung 1 logs `[daemon] AppImage daemon host fallback reason=<reason>`, where the reason is
`no-extracted-copy`, `no-bundled-node`, `no-daemon-entry` or `version-mismatch`. A rung that fails to
start logs before the next one runs. Rungs 1 and 2 record the same identity, `$APPIMAGE/<entry>`. That
means a running daemon is adopted whichever rung started it: as a normal target at the same version,
and preserved while busy across an upgrade, as for any other daemon.
