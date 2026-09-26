# OMP recorded transcript resume

A sleeping OMP session can retain its transcript path from a hook without an
explicit `launchConfig.ompResumeFilePath`. Both cold-restore startup and generic
sleeping-session launch already forward the provider metadata to
`getAgentResumeArgv`; that builder must keep the recorded path.

Resolution order is explicit launch path, recorded transcript path, then UUID.
The existing shell-aware builder quotes the selected argument for the execution
host. An older metadata record without a path retains UUID fallback. OMP provider
claim keys and equality remain UUID-based, so a later hook adding the path does
not create a second automatic-resume identity.

`tests/tools/omp-resume-transcript-locator-smoke.mjs` creates an actual OMP session
outside its default session store. UUID lookup fails there; the absolute path and
Orca's generated argv resume the original session. Run it with Bun and a read-only
OMP checkout as argv[2], under `ORCA_BACKGROUND_LAUNCH=1`. It uses a disposable home
and makes no model requests.

This bounded correction follows the resume-locator portion of
[PR #16276](https://github.com/stablyai/orca/pull/16276) by @CodeHourra. It does not
adopt that PR's reattach injection or title changes. The reattach proposal treats
missing snapshot/replay as permission to type a resume command, but
`daemon-pty-spawn-result.ts` explicitly permits `isReattach: true` without a
snapshot. That payload absence is not positive evidence of a newly created shell.
The proposal also adds the path to OMP claim identity, which separates UUID-only
metadata from a later path-enriched record for the same provider session. Those
changes require separate evidence and are outside this patch's review scope.
