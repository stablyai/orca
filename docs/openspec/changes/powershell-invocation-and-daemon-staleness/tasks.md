> **Status: not verified end to end.** Tasks 2.8 and 2.9 are open — the refreshed daemon was never
> relaunched and no teammate pane has been observed working. Unit tests and artifact inspection show
> only that the build *can* behave correctly; they say nothing about the running PTY materialisation
> path, which is precisely what masked this defect for three cycles. Treat the invocation fix as
> unproven until a clean-daemon run succeeds.

## 1. Make a relayed startup command invocable under PowerShell

Files: `src/main/providers/windows-shell-args.ts`, `src/main/providers/windows-shell-args.test.ts`.

- [x] 1.1 Add `ensurePowerShellInvocable`, prefixing the call operator when a startup command's first non-whitespace character is a single or double quote.
- [x] 1.2 Apply it inside `getPowerShellEncodedCommand`, where the command is appended to the OSC 133 bootstrap — the point at which the text becomes PowerShell source.
- [x] 1.3 Leave already-invocable commands untouched: the call operator, the dot-source operator, and bare command names.
- [x] 1.4 Cover a quoted absolute path with `--` arguments, decoding the `-EncodedCommand` payload to assert the delivered text.
- [x] 1.5 Cover the three shapes that must not be modified, iterating them in one test.
- [x] 1.6 Confirm the existing callers that hand-write `& '…'` still pass unchanged.

## 2. Diagnose why the fix did not take effect

No code changes. Recorded because the diagnosis, not the fix, was the expensive part.

- [x] 2.1 Confirm the fix is present in the build output, the installer, and the installed application — by extracting files, not grepping the archive.
- [x] 2.2 Identify that PTYs are spawned by a separate long-lived daemon rather than the application process.
- [x] 2.3 Compare the daemon's bundle against the installed one: chunk built 27/07 without the fix versus 28/07 with it.
- [x] 2.4 Confirm the daemon process survived every reinstall — same pid and start time across three cycles.
- [x] 2.5 Read `daemon-host-relocation.ts` and establish that materialisation short-circuits whenever the marker's version equals the application version, with no content check.
- [x] 2.6 Establish why each natural remedy fails: reinstalling leaves the marker matching; deleting the directory fails on the locked executable and is swallowed; stopping the daemon alone still short-circuits on the marker.
- [x] 2.7 Unblock the local instance by removing the marker, keeping a backup.
- [ ] 2.8 Stop the daemon and relaunch so the re-copy publishes. **Requires ending the active session; not performed.**
- [ ] 2.9 Observe the teammate pane working. **The outcome this change exists for; never yet seen.**

## 3. Daemon materialisation — proposed, not implemented

Files: `src/main/daemon/daemon-host-relocation.ts` *(unchanged)*.

- [ ] 3.1 Key materialisation on a content hash of the daemon sources, or add a build identifier to the marker, so two builds sharing a version are distinguished.
- [ ] 3.2 Make a failed refresh observable instead of fail-open — the current catch makes "could not update" indistinguishable from "already current".
- [x] 3.3 Document a supported force-refresh path for local development until the above lands. See the Deployment section of `proposal.md` for the exact marker path, the ordered commands, and why each single-step remedy fails.
- [ ] 3.4 Consider upstreaming: the defect is not Windows-specific and not caused by the agent-teams work.

## 4. Follow-ups not in this change

- [ ] 4.1 cmd.exe panes cannot run a single-quoted executable path, since cmd treats single quotes literally.
- [ ] 4.2 Instrument the daemon at the point it hands the command to PowerShell, if the invocation fix still fails after a clean daemon — observation rather than inference is the next step.
