# Qoder CLI integration

Orca registers `qodercli` as `qoder`: detection, picker/settings, desktop and mobile
identity, prompt launch, permission flags, managed hooks, workspace trust, and
session resume use the existing TUI-agent and hook-status paths.

## Verified contract

Verified on macOS with Qoder CLI 1.1.64, including its versioned executable
`qodercli-1.1.64`:

- `--prompt-interactive` starts an interactive prompt; `--resume <id>` resumes a
  session; `--dangerously-skip-permissions` is the permission bypass flag.
- Hooks use the Claude-shaped nested configuration in `~/.qoder/settings.json`.
  Orca registers its own `/hook/qoder` source and preserves user hooks.
- Real SessionStart, UserPromptSubmit, Notification and SessionEnd events are
  captured in `src/shared/__fixtures__/qoder-no-account-hooks.jsonl`, including
  `source: resume` with the original session ID.
- Trust is `permissions.trustDirectories` in that settings file, using the
  canonical workspace path. A workspace `.trusted` marker did not bypass the
  trust dialog in this version. Remote trust uses the execution host filesystem.
- Qoder emits its `◇ … | Ready` title while the trust menu owns input. Readiness
  therefore requires the live composer text, not merely this title or silence.
  Raw PTY fixtures under `src/main/runtime/__fixtures__/qoder-*` cover trust,
  unauthenticated prompt handling and the ready composer.
- A hidden Orca dev instance launched Qoder from New Tab in a folder workspace.
  Its icon, label, terminal rendering and failed-turn indicator were inspected.
  A harmless prompt reached Qoder, which reported its credit usage limit; the
  canonical hook store recorded Qoder identity, session metadata and failure.

## Compatibility and limits

Windows hooks explicitly select Qoder's documented PowerShell shell, avoiding
an assumption that Qoder uses Git Bash just because it is installed. They reuse
the existing managed `.cmd` payload without adding an encoded PowerShell hop.
The configuration shape and preservation are tested; Windows, Linux and SSH
execution have not been exercised live here.

Resume requests to remote hosts require `agent-session.qoder-resume.v1`, so an
older host is not sent an agent enum it cannot accept. Remote hook installation
and trust preservation have automated coverage.

Successful model output, tool execution and live permission dialogs remain
unverified because the available account has exhausted its credits. Hook event
mapping for these paths follows the official documentation. The China executable
`qoderclicn` is not registered; it was not available for verification.

Every launch Orca starts (New Tab, workspace and draft launches, automations)
pre-trusts the workspace at spawn while the agent-wide "Trust the folder when
Orca starts an agent" setting is on. A hand-typed `qodercli` in a plain terminal
can still show Qoder's trust dialog.

## Sources

- [Official hooks documentation](https://docs.qoder.com/cli/hooks)
- [#15291](https://github.com/stablyai/orca/pull/15291): registration and hook proposal
- [#13311](https://github.com/stablyai/orca/pull/13311): icon asset (commit
  `b56197025530adb1b82d97a364a8c3d4a02c0d42`) and agent integration
- [#8611](https://github.com/stablyai/orca/pull/8611) and
  [#12910](https://github.com/stablyai/orca/pull/12910): contributor implementations
- [#16540](https://github.com/stablyai/orca/issues/16540): Qoder misidentified as Gemini

Contributor patches informed the integration; they were not applied wholesale.
In particular, the trust marker proposal was replaced using the installed CLI's
observed settings write, and no renderer workaround was added because the live
WebGL terminal rendered correctly.

## Cross-review of open proposals

Reviewed the current patches for all six open Qoder PRs on 2026-09-28:

| PR | Incorporated or confirmed | Deliberate differences |
| --- | --- | --- |
| #7502 (vincent-lxc) | Agent registration, mobile parity, identity before Gemini | Use structural titles and the current public permission flag. |
| #8611 (Eridanus117, building on #7502) | Qoder hook source, notification/permission mapping, session resume | 1.1.64 supports `--prompt-interactive`; preserve startup session identity and ignore compact restarts. |
| #9655 (xingqingzzp-gif) | Cross-checked minimum registration coverage | Placeholder icon and detection-only scope are superseded by the fuller integration; no code copied. |
| #12910 (jyang2004) | Reuse the Claude-compatible installer with an event subset, plus remote installation | Use observed `.qoder` path and `/hook/qoder`; Qwen and the China build remain separate work. |
| #13311 (sorrycc) | Icon, structural title disambiguation, headless detection, display glyph cleanup | No DOM renderer override: 1.1.64 renders correctly in the live WebGL terminal. No unverified executable alias. |
| #15291 (adlternative) | Versioned binary recognition, trust preflight wiring, skills mapping and resume | Trust comes from settings, not `.trusted`; include notifications, permission and failure events with Qoder-specific normalization. |

The rendered left sidebar was checked in the hidden Electron app using a temporary
folder workspace and real Qoder hooks. The workspace fixture needed a parent path
on its project group to appear in the sidebar. No agent status was injected into
the renderer. A real prompt updated the row text and returned a credit-limit error;
the row and workspace card showed failure with the Qoder icon. A DOM observer
recorded the prompt-row transition before failure. Permission/waiting and successful
completion remain automated event-mapping tests, not live model/tool verification.

Commit co-authors credit all six proposal authors for the implementation and
registration groundwork, including xingqingzzp-gif’s minimal registration proposal.
