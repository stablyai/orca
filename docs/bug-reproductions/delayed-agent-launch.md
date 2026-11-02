# Delayed terminal agent launches

## Reproduction (2026-10-12, macOS)

An isolated Orca dev instance ran off screen with `ORCA_BACKGROUND_LAUNCH=1`.
In a folder workspace, `terminal create --command 'sleep 30 && claude'` launched
real Claude Code 2.1.296 after the delay. SessionStart, working and done hooks
arrived, and a prompt requesting `DELAYED_LAUNCH_OK` completed. A blanket Claude
hook failure was **not** reproduced on this machine.

The same delayed command was captured through
`config/scripts/capture-agent-pty-transcript.mjs`. Its startup emits
`OSC 0;✳ Claude Code`, terminal capability queries, and the normal composer.
The capture was scanned for identifiers and credentials; raw output is kept
outside the repository.

Deterministic reproductions found these failures:

- All 45 configured harnesses lost hidden startup query eligibility behind
  `sleep 30 &&`. The renderer query-delivery test also reproduced the drop.
- Delayed OpenCode 2 selected and installed OpenCode v1 hooks. Disabling the
  requested version could install the other version instead.
- Delayed Pi, OMP and Prime launches lost explicit preparation of their own
  integration. Managed OpenCode/Devin accounts and MiMo overlays also relied on
  first-executable classification.
- Once foreground discovery exhausted its initial read window, a captured late
  Claude startup title did not restart confirmation. The connection test left
  process routing unset at 30 seconds.

After the fix, a fresh `sleep 30 && claude` launch gained process-confirmed
routing. Real turns running `sleep 8` and `sleep 20` completed with the requested
replies. CDP screenshots showed the working indicator during a turn and the done
indicator with the completed reply. Blocked, waiting and interrupted turns were
not exercised.

## Change and invariant

`agent-session.delayed-terminal-launch` in `config/reliability-gates.jsonc`
tracks this contract: a delayed launch retains harness preparation and hidden
terminal replies, while only the execution host can confirm a live process.

A shared, bounded scanner removes literal numeric `sleep … &&` prefixes **only
from preparation hints**. The shell receives the original command, including
the delay, arguments and conditional operator. Existing setup-sequence hints,
explicit harness choices, disabled integrations and account ownership retain
precedence. Process-table command recognition still treats the waiting shell
as a shell.

Callers use shared launch-token and launch-recognition APIs. Prefix handling is
contained in `src/shared/agent-command-line-intent.ts`; the setup-sequence resolver
continues to return its supplied command. Launch recognition reuses the existing
agent registry and headless filters without changing strict process recognition.

Fresh agent startup titles request one additional bounded confirmation sequence
when initial discovery has finished. A title never supplies process identity or
input-routing authority. An active read is preserved; title storms, cancellation
and close are covered by deterministic read-count tests. No recurring timer or
sleep-length polling was added.

## Coverage and remaining gaps

| Surface | Evidence |
| --- | --- |
| Local and daemon preparation | Plugin files, account environment and host spawn tests |
| Renderer replies and routing | Hidden query-delivery and captured late-title tests |
| macOS real Claude | Hidden Electron/CDP launch and completed prompt |
| SSH/remote-runtime | Shared classification; existing fenced process reads retained; no physical delayed launch |
| WSL | Shared Pi/OMP and OpenCode preparation; physical guest launch unproved |
| Linux/Windows | Platform-neutral classification and existing mock coverage; physical delayed launch unproved |

The scanner intentionally does not parse arbitrary shell programs, variables,
pipelines or background jobs. A late agent emitting neither a recognizable title
nor hooks still needs a later input or visibility observation. No RPC field or
stream opcode changed; mixed-version wire behavior is unchanged.
