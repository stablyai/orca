# Updating remotes with the desktop app

User requirements recorded 2026-10-24:

- Add a choice to include remote Orca server updates in the desktop “Update Available” card.
- Remember that choice across future update prompts and app restarts.
- Default **ON for new users** and **OFF for existing users**. Preserve every explicit choice thereafter.
- Provide a few designs with screenshots in a gist before implementing the production change.
- Refinement: make this a **single, tiny checkbox, almost a footnote, underneath Update**, labeled **“Include remotes”**. Keep the “Update” button label. Use muted 12px text. Add a right-aligned dropdown arrow that reveals the full list of remotes targeted for the update, with smooth expand/collapse animation. Keep the list hidden by default; no counts or explanatory block in the collapsed card.

Current design: one small checkbox under Update, labeled “Include remotes,” with a separate arrow at the right edge of that row. The arrow expands an inline list of all eligible target servers and their version changes; opening it does not change the checkbox. Reuse `CollapsibleContent animation="height"` (200ms open, 180ms close, height and opacity), rotate the arrow, and respect reduced motion. This supersedes the earlier three-option explorations.

**The user approved this initial dialog on 2026-10-24.** Preserve it while iterating on progress.

Gist: https://gist.github.com/OrcaWin/bd08a2bb551df71a28d2fd5ba61b84ca

Implementation should extend the existing remote-server update coordinator and update dialog. Initialize the preference once using the existing new/existing-profile migration pattern, before default merging erases the distinction. Store the preference on the client profile, independently of the selected worktree, folder workspace, or remote host. Missing settings from older servers must not opt an existing user in.

When remotes are included, show that remote tabs may briefly disconnect during restarts. Update only eligible connected servers; do not queue offline servers for later. **Sub-agent-reviewed proposed order:** prepare downloads in parallel; get the local package downloaded and through the available validation checks before any remote install/restart; install remotes; restart local Orca last. Do not require an old client to reconnect to a server that needs the new client: retain the evidence, defer verification until after local restart, and never claim Updated without confirmation. A normal timeout is “Not confirmed,” with Check again (no blind reinstall) or Okay after the batch settles. The approved production flow updates included remotes and then the local app. Preserve mixed-version support and platform-specific update sources. Consider the same remote choice on mobile without presenting a desktop installer.

**Latest progress direction:** a compact, nonmodal card with **one moving activity bar** and a short stage label. Hide all per-remote details until the user expands it. The current collapsed prototype is 108px tall. Reuse the existing indeterminate bar animation rather than invent an overall percentage. Keep exactly one bar even when expanded; show per-remote stage/real download percentage as text, plus a separate “This app” row. The right-hand arrow smoothly expands/collapses details. Minimize hides progress without canceling.

**One remote fails:** let other remotes finish and preserve their successful results. While they are running, keep the bar moving and show a small “1 failed” indication. When the batch settles, pause the bar, show “1 remote failed” persistently, and hold the automatic local restart. Expanded details offer **Retry remote** (recheck state first; target only that remote) or **Okay**. Continuing installs the already prepared local package and preserves the remote issue across restart for later action. A reconnect timeout is **Not confirmed** and offers **Check again**, not a blind reinstall. The successful path still restarts local Orca automatically from the initial approval. Existing local installer blockers remain supported without repeating successful remote updates.

The order review also requires checking each remote’s actual offered update (not comparing only to the currently installed client), freezing the target set, and persisting target identities, accepted install requests and outcomes before restarts. Persist the renderer recovery checkpoints durably; a resolved batch promise does not prove every remote succeeded. Recover by rechecking saved outcomes after relaunch, not by blindly rerunning installs.

Current progress assets: `/home/neil/orca/artifacts/compact-update-progress-2026-10-24/` contains the compact bar, expanded/failure screenshots, animation, self-contained prototype, source, and validation results. The independent order review remains at `/home/neil/orca/artifacts/update-progress-2026-10-24/`. Approved initial-dialog assets remain at `/home/neil/orca/artifacts/include-remotes-2026-10-24/`. Earlier explorations remain in the other dated artifact folders. These earlier assets are prototypes. The PR includes production implementation screenshots from hidden Electron renderers.

Final implementation decisions:

- Minimized progress uses the existing status-bar position, with a persistent warning and click to restore the same compact card. Minimize does not cancel or reopen on ordinary progress changes.
- The failure action is **Okay**. Before restart it installs the prepared local package and retains the unresolved remote record. After restart, recovery offers check/retry and an Okay acknowledgement.
- Bind all remote operations and recovery to the saved pairing revision. A same-ID re-pair must never redirect an approval to another machine.
- Combined updates require the additive `updater.target-version.v1` capability. New servers atomically enforce the approved target at install. Legacy servers remain listed with a route to one separate update; existing standalone updates retain their no-parameter protocol.
- Only the primary desktop renderer may write the recovery journal. Flush it before remote installs and local restart. Web/mobile retain their individual remote-update flow and do not install desktop packages.
