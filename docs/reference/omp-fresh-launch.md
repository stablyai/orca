# Fresh OMP launches

Orca's new-session and draft launch plans apply a one-time `--config` overlay
containing `autoResume: false`. OMP's configured session directory, settings,
authentication and extensions remain in their usual locations. Saved launch
configuration omits the overlay so explicit resume keeps its normal semantics.
Custom commands with session selectors, unknown flags, positional arguments or
shell compounds are left unchanged.

The execution host creates the overlay. Local and WSL terminals use Orca userData
(with WSLENV path translation); SSH relays use their own managed directory. Config
creation is independent of status-hook preferences and does not require plugin
source installation. An unavailable file produces a terminal diagnostic and skips
OMP. Filesystem failures do not prevent unrelated agents or bare shells starting.

The guard invokes OMP in the current shell, preserving functions, aliases and the
managed status wrapper. A nonzero agent exit never triggers a second launch.
POSIX commands also support fish; environment presence is checked before expansion
so an old host under `set -u` reports the same missing-settings diagnostic.

## Mixed versions

The existing command and environment transport carries the launch unchanged; no
new RPC or stream opcode is introduced. A new host exports the path before shell
startup, including bare shells that receive an OMP command later. An old client
continues its existing launch behavior on a new host. A new fresh-launch command
on an old host without the managed environment fails visibly and requests a host
update and terminal restart. It must not silently fall back to OMP auto-resume.

## Verification

`src/shared/omp-fresh-launch-shell.test.ts` runs actual available bash, zsh and fish
shells, checking exact argv, a single invocation, nonzero exit, deleted settings
and an absent environment variable. `src/relay/omp-fresh-launch-environment.test.ts`
checks the guarded command through relay environment assembly and the actual OMP
shell wrapper, retaining both extension and config arguments and prefill.
Local host assembly tests recognize guarded POSIX, cmd and PowerShell commands.

Run the actual OMP storage smoke against a read-only OMP checkout:

```sh
ORCA_BACKGROUND_LAUNCH=1 bun tests/tools/omp-fresh-session-runtime-smoke.mjs /path/to/oh-my-pi
```

For Windows, bundle `tests/tools/omp-fresh-launch-windows-smoke.ts` with
`bun build --target=node --outfile=/tmp/omp-fresh-windows-smoke.mjs`, transfer the
bundle to the host and run it using Node with `ORCA_BACKGROUND_LAUNCH=1`.
The smoke uses temporary files and process-local environment only. Both cmd and
PowerShell must pass existing/missing/unset/directory settings cases, preserving
exit 17 for the single successful launch and returning exit 1 without launching
when settings are unavailable. This passed on Windows host `awin` on 2026-09-14.
