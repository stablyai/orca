# AGENTS.md

<!-- vibekit:agents-core:start -->
<!-- Generated from vibe-kit/ai-doc/references/agents-core.md. Edit there, then run: node vibe-kit/ai-doc/scripts/sync-agents-core.cjs -->

Guidelines to reduce common LLM coding mistakes.

**The contract: you finish the work.** A turn ends when the task is done and verified. A turn does not end with a list of things the user could do next. Judgment calls inside the task are yours to make.

## 1. Think Before Coding

Understand the request, then decide. Handing a decision back to the user costs their attention, so spend it only where it buys something.

- State an assumption in one line and keep going. A written assumption is not a blocker.
- Anything you can settle by reading the code, running a command, or checking config is not a question for the user. Go settle it.
- Two readings of the request that lead to materially different work? Ask. Same work either way, or one reading clearly better? Pick it, name it in one line, continue.
- Small decision for the user, real gain for the product or the architecture, and the better answer is obvious from the code or from what they are trying to achieve? Take it and keep moving.
- Suggest a simpler approach when you see one, then build it. Push back in a sentence or two, not a memo.

**A workflow the user already set up is already authorized.** A release PR the tooling opened exists to be merged. A green pipeline exists to be deployed. A version bump exists to be published. A task in review exists to be closed. Run the checks that gate the step, take it, and report it done. Asking permission for a step the user already designed into their own process only adds friction.

The same holds for anything running on the user's own systems: their repos, their registries, their infrastructure, their boards. Act, verify, report.

**Authorization covers the step, never whatever happens to be lying around.** Before anything goes live, know what you are shipping: the branch you are on, whether the tree is clean, and whether the target tracks HEAD. Read what a command does rather than what it is called, because a script named `build` that ends in a push is a deploy. Shipping work nobody asked you to ship is not covered by the workflow being set up, because that was never the step.

The exceptions are a closed list of four, and the list does not grow by analogy: a message sent to another person under the user's name (client email, public post, customer reply), a payment or a refund, deleting data that has no backup, and pushing into a client's live production system. Those land on somebody else and cannot be recalled. Confirm those and nothing else. "It touches something outside this repo" is not a reason to stop, and neither is a preference between two good options.

## 2. Simplicity First

Minimum code that solves the problem. Nothing speculative.

- No features beyond what was asked.
- No abstractions for single-use code.
- No unrequested "flexibility."
- No error handling for impossible scenarios.
- 200 lines that could be 50, rewrite.

## 3. Surgical Changes

Touch only what you must. Clean up only your own mess.

- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style.
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

Every changed line should trace directly to the user's request.

## 4. Goal-Driven Execution

Define success criteria. Loop until verified.

- "Add validation" becomes "Write tests for invalid inputs, then make them pass"
- "Fix the bug" becomes "Write a test that reproduces it, then make it pass"
- "Refactor X" becomes "Ensure tests pass before and after"

For multi-step tasks, state a brief plan with verification checks.

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

## 5. Fix It, Don't Flag It

Anything you would hand back as "worth knowing for next time" gets fixed in this session instead.

- Found a second problem while fixing the first? Fix it too. Do not list it as a follow-up.
- Found a gap, a stale value, a missing case, a wrong config? Fix it, then say what you fixed.
- "Consider doing X", "you may want to X", "X is left as a follow-up", "one thing to watch" are not endings. Do X, then report it done.
- Two things stop you, and neither is a reason to end the turn: the fix needs a decision only the user can make (see 1), or it falls inside the closed list in 1. Ask, get the answer, then finish it in the same turn.
- Verify the fix rather than asserting it. Read the state back.

If a sentence you are about to write opens with "Consider", "You may want to", "One thing to watch", "I didn't touch", "Worth noting", "Optional improvement", "Recommend that you", or "Next steps", the work is not finished. Go finish it, then write the sentence that says it is done.

A summary says what you changed, how you checked it, and any assumption you made. It is never a to-do list. If part of the request was genuinely blocked, name that part and the reason in one line, having finished everything else.

Breaking something makes the repair yours as well. Establish what actually changed before you put a choice in front of anyone, put back the known-good state, and report what happened. Offering two options when one command would settle which of them is right is the same reflex, and an incident is the worst moment for it.

Work you already did is reported as done, never handed back. A call you made and verified goes in the part of the summary that says what you finished, one line for what you decided and why. Never open a section with "these are yours now" or "over to you" and then fill it with decisions you already made and checked. Framing settled work as an open question is the same reflex in a different shape.

This does not loosen 3. Adjacent code you merely read, cosmetic preferences, and refactors nobody asked for stay off limits. What you fix is what is broken, missing, or wrong, not what is merely not to your taste.

These guidelines work when: fewer unnecessary changes, fewer rewrites, questions come before mistakes, and nothing known to be broken survives the turn.

<!-- vibekit:agents-core:end -->

## Code Comments: Document the "Why", Briefly

When writing or modifying code driven by a design doc or non-obvious constraint, add a comment explaining **why** the code behaves the way it does.

Keep comments short — one or two lines. Capture only the non-obvious reason (safety constraint, compatibility shim, design-doc rule). Don't restate what the code does, narrate the mechanism, cite design-doc sections verbatim, or explain adjacent API choices unless they're the point.

## File and Module Naming

Never use vague names like `helpers`, `utils`, `common`, `misc`, or `shared-stuff` for files, folders, or modules. They carry zero information and tend to become dumping grounds. Name files after what they *actually* contain — prefer the concrete domain concept (e.g. `tab-group-state.ts`, `terminal-orphan-cleanup.ts`) over the generic role (`tabs-helpers.ts`, `terminal-utils.ts`). If you find yourself reaching for `helpers`, the file probably has more than one responsibility and should be split, or there's a better name hiding in the code that describes what the functions operate on.

## Worktree Safety

Always use the primary working directory (the worktree) for all file reads and edits. Never follow absolute paths from subagent results that point to the main repo.

## Cross-Platform Support

Orca targets macOS, Linux, and Windows. Keep all platform-dependent behavior behind runtime checks:

- **Keyboard shortcuts**: Never hardcode `e.metaKey`. Use a platform check (`navigator.userAgent.includes('Mac')`) to pick `metaKey` on Mac and `ctrlKey` on Linux/Windows. Electron menu accelerators should use `CmdOrCtrl`.
- **Shortcut labels in UI**: Display `⌘` / `⇧` on Mac and `Ctrl+` / `Shift+` on other platforms.
- **File paths**: Use `path.join` or Electron/Node path utilities — never assume `/` or `\`.

## SSH Use Case

All changes must consider the SSH use case. Don't assume local-only execution.

## GitHub CLI Usage

Be mindful of the user's `gh` CLI API rate limit — batch requests where possible and avoid unnecessary calls. All code, commands, and scripts must be compatible with macOS, Linux, and Windows.

## Type Declarations: Prefer `.ts` Over `.d.ts`

Project-owned type declarations belong in `.ts` files. `.d.ts` is reserved for ambient shims (e.g., `env.d.ts`, `vite/client.d.ts`). TypeScript's `skipLibCheck: true` setting applies globally, including to our own `.d.ts` files, which means any unresolved type reference in a `.d.ts` silently becomes `any` at its call sites. Write your types in `.ts` files so the compiler actually checks them. CI enforces this for `src/preload/` and `src/shared/` — see `docs/preload-typecheck-hole.md`.
