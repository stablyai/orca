# OMP transcript roots

Native chat lookup, history discovery and the history path allowlist use
`src/main/ai-vault/omp-session-root.ts` on the execution host. The resolver follows
the active runtime environment rather than scanning every profile.

The behavior matches OMP's `packages/utils/src/dirs.ts`:

- On Linux and macOS, an existing `$XDG_DATA_HOME/omp` selects that app's `sessions`
  directory, even when legacy transcripts coexist. The sessions directory itself
  need not exist yet. There is no implicit `~/.local/share` fallback.
- A named profile uses XDG only when its own `omp/profiles/<name>` path exists;
  otherwise it uses the profile's config-root `agent/sessions` directory.
- `OMP_PROFILE` takes precedence over `PI_PROFILE`, including an explicitly empty
  canonical value. Named profiles ignore custom `PI_CODING_AGENT_DIR` values.
  Default mode respects custom agent directories, except an inherited agent path
  derived from the lower-priority profile. `PI_CONFIG_DIR` selects the config root
  relative to the owning host's home, as upstream specifies.
- Orca retains its legacy `OMP_CODING_AGENT_DIR` sessions-root override and prefix
  normalization. Explicit scan roots override environment discovery. Empty or
  filesystem-root scan overrides and invalid profile names refuse discovery;
  they never fall back to a different profile or the process working directory.

The desktop scanner child allowlist forwards only the required directory/profile
variables. SSH relay discovery still builds legacy roots from its host-owned home
and does not gain XDG/profile discovery here. Client XDG/profile values are not
applied to WSL home roots. Exact hook
paths and existing WSL attestation/refusal remain authoritative. No wire fields
or opcodes change; older clients receive the existing session record shape.

This resolves environment-visible configuration. Per-command `--profile` choices
or directory values loaded only inside the agent are not inferred by a runtime
that never received them; hook-reported transcript paths remain the exact route.

Run the read-only upstream parity smoke with:

```sh
ORCA_BACKGROUND_LAUNCH=1 bun tests/tools/omp-session-root-upstream-smoke.mjs /path/to/oh-my-pi
```

The smoke uses disposable home/data roots and compares Orca's result with OMP's
actual directory resolver. It makes no model requests. Unit tests also cover
Windows XDG exclusion, legacy override normalization and refusal paths.

For actual persistence-to-reader validation, run:

```sh
ORCA_BACKGROUND_LAUNCH=1 bun tests/tools/omp-transcript-root-reader-smoke.mjs /path/to/oh-my-pi
```

This creates default and named-profile transcripts through OMP's SessionManager,
with legacy directories still present, then resolves and decodes each by session
ID through Orca's native reader. All files use disposable roots; no model runs.
