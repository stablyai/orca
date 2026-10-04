# DeepSeek Build terminal identity

DeepSeek Build is the third-party [`innocarpe/deepseek-build`](https://github.com/innocarpe/deepseek-build) product, published as `@innocarpe/deepseek-build`. It is distinct from official DeepSeek Harness (`@deepseek-ai/dsh`), Reasonix, DSH Console and generic DeepSeek TUI wrappers.

Orca recognizes manually started Build terminals through its existing process and title observations. `TerminalAgent` includes `dsb`; the launchable `TuiAgent` registry does not. No Build launcher, hook, readiness profile, resume command or history reader is registered. Existing generic terminal input remains available.

The source and actual macOS release were checked at **v6.9.0**, source commit `74df67a56988e9a32845c4565cc62b021ea68c7d`. The darwin-arm64 release tarball SHA-256 is `a57f225a537fc5c027ac4592e3f37f7bdc28cc2d6e27a366934511ea565cb874`.

- `package.json` publishes `dsb.js` and `deepseek-build.js` npm shims; the native child is `deepseek-build-agent`.
- `crates/dsb-cli/src/main.rs` separates the full-screen entry from `run`. Global value options such as `--cwd` can precede `run`; those invocations remain excluded from interactive recognition.
- `crates/dsb-cli/src/agent_launch.rs` emits the product OSC 0 title. The vendored pager's `notifications/title.rs` composes spinner, activity and product segments with ` - ` separators.
- The committed `dsb-6-9-0-folder` PTY fixture records the released binary's welcome screen and actual title in an isolated home and plain folder. It makes no successful-authentication or completed-model-turn claim. Its runtime test feeds raw chunks through `onPtyData` with foreground inspection unavailable.

Explicit native owner markers retain their existing precedence. A Claude task merely mentioning Build is not a Build identity. Runtime publication reuses the existing optional `agentIdentity` string; no new RPC, stream opcode or status producer is added. Older hosts can omit identity, while older readers retain their existing unknown-agent handling. Execution-host process/title observations work without a Git repository; local source tests do not establish native Windows, Linux or SSH device coverage.

For rendered proof, isolate both Electron and the actual PTY. On macOS, `login(1)` can replace the shell's inherited home. Test-only `ORCA_DISABLE_MACOS_LOGIN_SHELL=1` avoids that wrapper; do not change production launch policy for a proof. Require a nonce-bound file written by a helper executed in the spawned PTY, containing its actual `HOME`, `USERPROFILE`, `DEEPSEEK_BUILD_HOME`, `GROK_HOME` and trust-RPC flag, and verify it before agent launch. A terminal-text assertion can match command echo and is not isolation evidence. Explicit provider environment at the final execution boundary protects the test even after shell startup.

The observation-type propagation and title/process recognition adapt Wooseong Kim's (`innocarpe`) [PR #23485](https://github.com/stablyai/orca/pull/23485), with source-backed corrections for the second npm shim and value options before `run`. Keep that predecessor open until a reviewed successor merges.

Independent review follow-up: upstream 6.9.0 outer `Commands::Agent` forwards native PagerArgs options. Native `-p`/`--single` (alias `--print`), `--prompt-json` and `--prompt-file` are one-shot forms and are excluded from interactive process/foreground identity, including equals/compact short forms, npm wrappers and preceding value options. Positional interactive prompt text, native option values and the native `--` terminator stay distinct. Actual release native `--help` confirms exposed flags; source alias and forwarding are pinned above.

Title follow-up confines Gemini identity/normalization and status sniffing before inspecting Build activity text. A verified Build title uses its leading own braille frame for working and leading `⚠ Action Required - ` for permission; embedded Gemini glyphs in activity/session/cwd text do not change its identity or status. Source-backed frame tests cover wrapped and alert variants, plus OSC input through the actual runtime/listing path. Native Gemini and other provider corpus contracts stay covered.

Actual released outer `dsb agent -- --help` prints the native TUI help (`outer-forwarded-help.txt`), confirming Clap consumes the outer separator before forwarding. The observer distinguishes this from the native `--`: `dsb agent -- --print task` is one-shot, whereas `dsb agent -- -- --print` and direct native `-- --print` retain literal interactive prompt text.

Native grammar follow-up: only the outer wrapper's `run` subcommand is one-shot. Native `deepseek-build-agent run`, forwarded `dsb agent run`, and `--leader-socket run` remain interactive; the last consumes `run` as a path value. Native `-c` is boolean, so Clap accepts `-cp task` and `-cptask` as continue plus single-turn prompt. Attached `-m`/`-r`/`-s`/`-w` values (including after `c`) do not expose a prompt flag. The released binary accepted the five review argument topologies with `--help` under an executed private-child environment assertion (`native-grammar-oracle.json`); this proves parsing/help, not successful model generation.

Attached prompt values can begin with hyphens: native `-p-` and `-cp--print` consume `-` and `--print` as the single-turn prompt. The observer accepts the entire remainder after `p`, while the attached m/r/s/w value shields stay covered. The released native binary and outer `agent` wrapper accepted both forms with `--help` in a nonce-asserted private child (`attached-p-oracle.json`).
