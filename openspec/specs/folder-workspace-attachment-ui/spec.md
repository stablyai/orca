# Folder Workspace Attachment UI Specification

## Purpose

Let users attach an existing Git worktree to an existing folder workspace from the left sidebar, with safe execution-owner routing and authoritative parent-link presentation.

## Requirements

### Requirement: Separate sidebar folder attachment action

The sidebar SHALL expose `Attach to Folder Workspace…` for a single existing Git worktree, separate from the existing Git-parent action. Opening the action SHALL target the row the user invoked, not whichever workspace later becomes active. It MUST NOT require another eligible Git worktree parent. Folder cards, deleting worktrees, and multi-selection SHALL NOT initiate this single-worktree operation.

#### Scenario: Worktree has no other Git parent candidates

- **WHEN** the user opens a single worktree's context menu and an eligible folder workspace exists but no eligible Git parent exists
- **THEN** the folder attachment picker can be opened independently of the Git-parent action

#### Scenario: Active workspace changes after opening

- **WHEN** the active workspace changes while the folder attachment picker is open
- **THEN** selection still addresses the captured child identity and owning runtime
- **AND** it does not mutate the newly active workspace

### Requirement: Searchable eligible folder destinations

The picker SHALL list existing, non-archived folder workspaces whose execution host and owning runtime namespace match the captured child. It SHALL show folder names with group/path context sufficient to distinguish equal names. Search SHALL cover those displayed fields. The current confirmed parent SHALL be identifiable and SHALL NOT trigger a redundant mutation. Unknown or ambiguous ownership MUST NOT become an assumed local destination. An explicitly selected same-owner folder in another project group SHALL remain eligible without changing repository membership.

#### Scenario: Explicit attachment across project groups

- **WHEN** the user selects an eligible folder belonging to another project group on the same execution owner
- **THEN** the worktree can be attached without moving or registering its repository into that group

#### Scenario: Foreign host or runtime has a matching folder name or ID

- **WHEN** folders on another SSH target or paired runtime share a name or bare ID with a local eligible folder
- **THEN** foreign destinations are not offered as interchangeable candidates
- **AND** a selected destination is resolved in the captured child's runtime namespace

#### Scenario: No eligible destination or catalog unavailable

- **WHEN** the owner-scoped catalog successfully loads with no eligible folders
- **THEN** the picker displays an informative empty state without creating anything
- **WHEN** the catalog cannot be loaded or ownership cannot be resolved
- **THEN** the picker reports unavailable scope rather than claiming that no folders exist

### Requirement: Apply one parent relationship without checkout side effects

Selecting an eligible folder SHALL apply a folder-parent relationship to the existing child through the owning runtime. The relationship SHALL replace a prior Git or folder parent rather than add a second parent. The operation MUST preserve the child's checkout identity, files, branch, repository registration, and project-group membership. It MUST NOT create worktrees, folders, terminals, or agent sessions. Changing the captured checkout occupant or resolving an ambiguous child MUST cause refusal rather than mutation of another row.

#### Scenario: Replace a Git parent with a folder parent

- **WHEN** the user confirms a folder destination for a worktree currently nested under a Git parent
- **THEN** the folder becomes its sole parent and the previous Git-parent relationship is removed
- **AND** no checkout, branch, file, or repository-membership change occurs

#### Scenario: Move between folder parents

- **WHEN** a worktree attached to one folder is attached to another eligible folder
- **THEN** only the new folder owns the parent relationship
- **AND** the old folder no longer includes that child in its attachment count

#### Scenario: Checkout occupant changed or row identity is ambiguous

- **WHEN** the captured child no longer identifies the same checkout occupant or cannot be targeted unambiguously
- **THEN** attachment is refused with a visible explanation and no other same-ID workspace is mutated

### Requirement: Present confirmed authoritative lineage

After a successful attachment, the UI SHALL use owner-produced workspace lineage to update sidebar nesting, folder child counts, and Workspace Board folding. A null Git-parent value MUST NOT be interpreted as absence of a folder parent. Obsolete inline Git-parent presentation SHALL be cleared only for the affected identity. A confirmed child SHALL appear under the selected folder when that folder is rendered and expanded; an existing collapse/filter state SHALL remain respected. Reloading the application SHALL retain the relationship. The existing detach action SHALL continue to clear it without deleting the worktree. Its label SHALL read `Remove from Folder Workspace` when the parent is a folder workspace and `Remove from Parent` for a Git parent. A folder-attached worktree SHALL offer `Change Parent Worktree...` for choosing a Git parent, which replaces the folder relationship.

#### Scenario: Folder attachment returns no Git lineage

- **WHEN** the parent mutation succeeds and its Git-lineage value is null while authoritative workspace lineage confirms the folder edge
- **THEN** the child is displayed beneath that folder rather than being treated as parentless
- **AND** it has no duplicate ordinary-lane or independent board card caused by stale presentation

#### Scenario: Folder is collapsed and application restarts

- **WHEN** attachment is confirmed to a collapsed folder and the application is restarted
- **THEN** the folder retains the child relationship and count
- **AND** expanding the folder reveals the existing child without recreating it

#### Scenario: Detach through existing sidebar action

- **WHEN** the user chooses `Remove from Folder Workspace` for an attached child
- **THEN** the folder edge is removed and ordinary sidebar/board placement is restored under current visibility policy
- **AND** the checkout and files remain intact

### Requirement: Honest failure and mixed-version behavior

A rejected attachment SHALL produce a visible failure and MUST NOT fabricate a new parent or remove a confirmed previous parent. Deleted destinations, host conflicts, unsupported older hosts, and unavailable scope SHALL be handled without local-host substitution. A timed-out response MUST NOT be treated as proof of rejection or silently resent. If the host acknowledges the write but authoritative lineage cannot be verified, the UI SHALL report that acknowledgement and refresh uncertainty separately. Missing folder-lineage metadata from an older host MUST NOT be normalized into a confirmed empty folder relationship. Late refreshes MUST NOT overwrite a newer attachment or detachment.

#### Scenario: Destination disappears or backend refuses ownership

- **WHEN** the selected folder is deleted or the host rejects its ownership before applying the mutation
- **THEN** the user sees an error and the previous confirmed parent remains unchanged

#### Scenario: Write acknowledged but lineage refresh fails

- **WHEN** the host acknowledges attachment but the follow-up authoritative read fails or omits required folder-lineage evidence
- **THEN** the UI reports the acknowledgement and unavailable verification without claiming a confirmed new placement or automatic rollback
- **AND** it does not automatically repeat the mutation

#### Scenario: Mutation outcome is unknown

- **WHEN** communication times out before an acknowledgement is received
- **THEN** the UI reports an unknown outcome and reconciles through owner-scoped reads when available before allowing a repeat mutation

#### Scenario: Newer parent change wins over delayed refresh

- **WHEN** an older attachment refresh arrives after a newer attachment or detachment
- **THEN** the newer state remains visible and other hosts' lineage is preserved

### Requirement: Accessible localized picker interaction

The new menu action, picker guidance, loading/empty/error states SHALL be localized and follow existing sidebar controls. Search SHALL receive focus on open; existing keyboard navigation and Enter selection SHALL work; Escape or outside dismissal SHALL close without mutation and restore focus to the sidebar. IME composition MUST NOT submit a destination accidentally.

#### Scenario: Keyboard selection and cancellation

- **WHEN** the user opens the action with the keyboard, searches, navigates, and presses Enter
- **THEN** the highlighted eligible folder is selected for the captured child
- **WHEN** the user dismisses with Escape or outside interaction instead
- **THEN** no mutation occurs and sidebar focus is restored

#### Scenario: Search during IME composition

- **WHEN** Enter is used to complete IME composition in the search input
- **THEN** no folder is attached solely because that composition key was pressed
