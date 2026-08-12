## 1. Windows shim forwards correctly

Files: `native/windows-cli-launcher/OrcaTmuxShim.cs`, `config/scripts/build-windows-cli-launcher.mjs`.

- [x] 1.1 Pass `agent-teams-tmux` as the first forwarded argument and stop including the target's own program name, so `src/cli/index.ts:45` dispatches.
- [x] 1.2 Remove the fabricated `tmux 3.4` stderr write; `-V` is answered by the dispatcher.
- [x] 1.3 Route `.cmd`/`.bat` shim targets through `cmd.exe /s /c` with each argument quoted, so the dev path can start at all.
- [x] 1.4 Return the forwarded target's exit code, and exit non-zero with a reason when it cannot be started.
- [x] 1.5 Add `--source <path>` to the build script so tests can compile a throwaway stub instead of silently rebuilding the launcher.

## 2. Tests that assert what they claim

Files: `config/scripts/tmux-shim-argv-fidelity.test.mjs`, `config/scripts/build-windows-cli-launcher.test.mjs`.

- [x] 2.1 Rewrite the PATH-precedence tests to assert a positive — a recording stub receives `['agent-teams-tmux', '-V']` — rather than only that a decoy did not answer. Cover both shell and shell-less resolution.
- [x] 2.2 Compile stubs via `--source` so the argv-fidelity scenarios test the shim rather than the CLI launcher.
- [x] 2.3 Add scenarios for metacharacter fidelity, pane format strings, a batch-file target, exit-code propagation, and the absence of a fabricated sentinel.
- [x] 2.4 Replace the build-script assertion that the binary embeds `tmux 3.4` — it locked in the defect from 1.2 — with one asserting `agent-teams-tmux` is present and `tmux 3.4` is absent.
- [x] 2.5 Correct the file header, which claimed the tests were skipped on Windows CI when they run there, and blamed a missing Orca installation for what was the `--target` bug.

## 3. Shim installation

Files: `src/main/runtime/claude-agent-teams-shim-env.ts` and its test.

- [x] 3.1 Try the packaged shim, then the local dev build; do not stop at the packaged miss. Electron sets `resourcesPath` in dev too, so the previous early return made the dev build unreachable.
- [x] 3.2 Stamp the copied file's mtime so the size+mtime idempotence check holds on POSIX, where `copyFile` does not preserve it.
- [x] 3.3 Read the shim-bin lookup PATH case-insensitively.
- [x] 3.4 Cover: copies when packaged, falls back to dev, tolerates neither present, does not rewrite an unchanged file, copies nothing on non-Windows.

## 4. PATH casing — the ENOENT

Files: `src/shared/env-var-casing.ts` *(new)* and its test, `src/main/runtime/claude-agent-teams-service.ts` and its test.

- [x] 4.1 Add `readEnvVar` and `resolveEnvVarKey`. Native Windows processes expose `Path`, so reading `.PATH` yields undefined and the composed PATH collapsed to the shim directory alone.
- [x] 4.2 Compose the team PATH from a case-insensitive read.
- [x] 4.3 Write PATH back under the caller's own key so a Windows child cannot end up with both `Path` and `PATH` at different values.
- [x] 4.4 Cover both casings, exact-match precedence, and that unrelated keys sharing a prefix (`PATHEXT`) are ignored.

## 5. Detection and launch on Windows

Files: `src/shared/tui-agent-config.ts`, `src/main/ipc/tui-agent-detection-commands.test.ts`, `src/main/ipc/preflight.test.ts`, `src/shared/tui-agent-startup.test.ts`.

- [x] 5.1 Change `detectUnsupportedRuntimes` from `['win32','wsl']` to `['wsl']`. This fourth gate is why Settings showed "Available to install" regardless of the other fixes; it controls detection, not the launch plan.
- [x] 5.2 Keep WSL unsupported — the shim calls back into the host Orca process.
- [x] 5.3 Set the Windows launch command to `claude --teammate-mode auto`, launching Claude directly instead of through the Orca CLI, which runs inside Electron-as-node and hands its child a non-TTY stdin.
- [x] 5.4 Invert the two tests pinning the old detection behavior, and add one asserting the agent is still not reported on Windows without the Claude CLI.
- [x] 5.5 Update the startup-plan test pinning the old Windows launch command.

## 6. send-keys key mapping

Files: `src/shared/claude-agent-teams-tmux-compat.ts` and its test.

- [x] 6.1 Replace the 15-case switch with a named-key table covering `Up`/`Down`/`Left`/`Right`, `Home`, `End`, `PPage`/`NPage`, `IC`/`DC`, `BTab`, plus the aliases `PageUp`, `PageDown`, `Insert`, `Delete`.
- [x] 6.2 Map any `C-<letter>` and the bracket chords with `charCode & 0x1f`. The intuitive `- 96` is wrong for `C-[`, which would yield a negative code point.
- [x] 6.3 Keep unrecognised names literal, so ordinary prompt words are never dropped, and keep literal mode untranslated.
- [ ] 6.4 *(deferred)* `F1`–`F12` remain literal text.

## 7. Packaging verifier

Files: `config/packaged-runtime-node-modules.cjs`.

- [x] 7.1 Accept `isBuiltin(specifier)` alongside the `builtinModules` set. Prefix-only builtins (`node:sqlite`, `node:test`, `node:sea`) are absent from that list on every current Node version, so a legitimate `node:sqlite` import aborted packaging.
- [ ] 7.2 Submit this upstream separately — the file is byte-identical on `origin/main`, so the defect is not Windows-specific and not caused by this work.

## 8. Verification

- [x] 8.1 Confirm the installed `app.asar` contains each shipped fix, rather than only the build output.
- [x] 8.2 Confirm the shim is copied into the user shim directory with matching size and mtime.
- [x] 8.3 Reproduce the ENOENT against the running build and confirm it is resolved — caller sending `Path` yields a full PATH with the agent CLI resolvable.
- [x] 8.4 Confirm detection reports the agent.
- [x] 8.5 Confirm the dispatcher drives real panes end to end.
- [ ] 8.6 Confirm a visible, interactive Claude TUI via the UI launch path. **Not yet done** — this is the fix from 5.3 and the reason the change is not complete.
- [x] 8.7 Confirm Claude invokes the shim and a teammate pane is created. Observed indirectly but conclusively: the PowerShell parse errors behind defects 13, 14 and 15 came from Claude's own teammate commands running inside shim-created panes.
- [ ] 8.8 Confirm the created teammate pane renders a working, interactive TUI. **Not yet done** — the fixes for 13/14/15 never reached the running daemon, so the outcome after them is unobserved. This is the outcome the change exists for.

## 9. Follow-ups not in this change

- [ ] 9.1 `terminal-attribution.ts` and `pty.ts:971`/`979` write `baseEnv.PATH` and can leave both casings set on Windows. The attribution one affects every Orca terminal, not just agent teams.
- [ ] 9.2 Teach `agent-process-recognition.ts` to match `claude --teammate-mode auto`, so Windows stops labelling the agent plain "Claude".
- [ ] 9.3 Decide CI coverage for the Windows-only scenarios, or state plainly that they are developer-run.
- [ ] 9.4 Install the MSVC C++ workload so local packaging stops needing the ABI-reuse and `--force`-removal workarounds.
