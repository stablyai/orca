# Lifecycle tradeoff review

| PR     | Result                                                                                     | Remaining user-visible cost                                                                                                                              |
| ------ | ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #21014 | Keep existing safety fence; 18 tests pass.                                                 | PTY inventory churn can require retry or report unavailable; missing host evidence cannot safely be treated as exited.                                   |
| #21020 | Keep post-acknowledgement identity check; 11 tests pass.                                   | A close racing a new tab/leaf/incarnation can require a fresh action.                                                                                    |
| #21175 | Withdraw the earlier normal remove/re-pair warning; no code change.                        | Explicit unpair deletes an unowned retired-ID mirror. Stale-ID direct reads and manual old-UUID restoration remain outside the demonstrated normal flow. |
| #21178 | Partial removal implemented: preserve existing bounded view caches while disposing models. | Monaco closed-file undo remains subject to its size budget, URI eligibility, and content match; raw Windows drive URI and >10 MiB controls lose undo.    |
| #21185 | Preserve-history alternative tested and rejected.                                          | Successful uninstall loses old worker logs. Keeping them retains all removed-key rings; an archive/eviction policy would introduce another cost.         |

## Publishable candidate for root review

`48d4af652e5a24758077bc9eaa81e05be1f1a08e` is parented directly on #21178 head `29820ed587cab4f2ab31a9306ca2180355b3e745`.

- Five changed paths; 23 production changed lines, 165 total changed lines.
- 43 tests across eight suites pass at this exact candidate.
- Ordinary lint, anti-slop, scoped TypeScript, and diff whitespace check pass.
- Full web TypeScript reports one unrelated, unchanged unused import in `NativeChatMessageList.windowing.test.tsx:12`; this is disclosed rather than called a full pass.
- All candidate exports match Git objects. Eleven test graphs contain 8,496 distinct verified head/path source records. The exact-source typecheck snapshot contains 22,435 verified files.
- Dependencies are the installed workspace versions. Tests used background launch; no desktop window was shown. No native Windows, live SSH, or affected-host session was exercised.

`7c9ba477a654a49a18576075139a3221eecf5f97` is a **rejected #21185 feasibility control**, not a publication candidate.

No source worktree/index changes, pushes, PR mutations, or merges were performed by this task.
