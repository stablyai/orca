# Folder Group Import Explanations Specification

## Purpose

Explain why a selected folder does not offer group import or why nested repository discovery returns fewer results than expected, without changing discovery policy or requiring filesystem changes.

## Requirements

### Requirement: Explain selected Git repository classification

Add Project SHALL expose an explicit `Import folder as group` entry that reuses existing host-specific path selection and discovery. Only when this entry was selected SHALL the flow pause on Git repository classification and explain that nested scanning was skipped, so this selection cannot be imported as a folder-backed project group. Ordinary `Browse folder` single-repository imports SHALL retain their existing uninterrupted behavior. The explanation MUST remain available in the result surface until the user continues or dismisses it; it MUST NOT rely only on a tooltip, console log, or expiring toast.

#### Scenario: Selected folder is a Git repository
- **WHEN** the user selected `Import folder as group` and the execution host reports that the selected path is a Git repository
- **THEN** Add Project identifies the selected path and states that nested repository discovery was skipped because of its Git repository classification
- **AND** the existing project-open outcome remains available without deleting or changing Git metadata

#### Scenario: Ordinary single-repository browsing
- **WHEN** the user selects a Git repository through ordinary `Browse folder`
- **THEN** the existing project-open flow proceeds without an exclusion explanation or additional confirmation

### Requirement: Explain observed directory exclusions

When the execution host provides exclusion diagnostics, the flow SHALL show an inline summary of excluded folders and expandable details containing their paths and reasons. For a `.gitignore` exclusion, details SHALL identify the source ignore file and effective excluding rule. Counts MUST describe observed directories, not unvisited descendants or presumed repositories.

#### Scenario: Parent ignore file excludes sibling folders
- **WHEN** the scan excludes two encountered folders because of rules in the selected folder's `.gitignore`
- **THEN** the result states that two folders were excluded by `.gitignore`
- **AND** expanding details identifies both paths, the matching rules, and the source ignore file
- **AND** the result does not claim that two repositories are missing

#### Scenario: Inherited ignore rules and negation
- **WHEN** an inherited rule excludes one directory and a later negated rule permits another
- **THEN** only the actually excluded directory contributes to the exclusion count
- **AND** its explanation identifies the effective excluding rule rather than an overridden match

#### Scenario: Other discovery exclusions
- **WHEN** observed directories are skipped by existing built-in directory, hidden-directory, or symlink policy
- **THEN** expandable details identify the respective reasons separately from `.gitignore` exclusions
- **AND** the scan does not traverse those directories to obtain an explanation

### Requirement: Explain zero results and incomplete coverage

The flow SHALL retain readable explanations when no repositories are found. It SHALL distinguish observed exclusions, depth-boundary non-traversal, repository-count limits, user cancellation, configured timeout, and directory-read failures. A read failure MUST NOT be presented as an intentional ignore rule or proof that the directory contains no repositories.

#### Scenario: All encountered candidate folders are ignored
- **WHEN** no repositories are returned and encountered folders were excluded by `.gitignore`
- **THEN** the result displays both the zero repository count and the observed ignore exclusions before the user continues with the existing folder-open outcome

#### Scenario: Depth boundary reached
- **WHEN** the scanner encounters a non-repository directory that it does not descend into because of the configured depth boundary
- **THEN** the result states that this folder was not searched below the boundary
- **AND** it does not infer repository counts beneath that folder or claim a deeper search occurred

#### Scenario: Scan stopped or reached another limit
- **WHEN** the execution host reports cancellation, timeout, or a repository-count limit
- **THEN** the result names the actual stop condition and retains the repositories found so far
- **AND** intentional folder exclusions remain a separate explanation

#### Scenario: Directory could not be read
- **WHEN** a directory read fails during discovery
- **THEN** the result identifies that directory as unreadable and states that its contents were not checked
- **AND** a generic read error is not relabeled as a permission error without supporting error information

### Requirement: Bound diagnostics and preserve discovery behavior

Collecting explanations SHALL preserve existing repository selection, traversal order, ignore matching, symlink handling, nested-repository stopping, scan budgets, cancellation, and import behavior. Diagnostics SHALL retain no more than 100 detail records per scan, count only observed decisions, and explicitly disclose omitted details when that cap is exceeded. Explanations MUST NOT add rescan or ignore-override controls, inspect pruned subtrees, modify files, or recommend deleting repository metadata or ignore files.

#### Scenario: Large number of exclusions
- **WHEN** a scan observes more than 100 reportable directory decisions
- **THEN** the response retains at most 100 detail records, reports counts of observed decisions, and identifies that additional details were omitted
- **AND** diagnostics do not trigger additional filesystem traversal or Git subprocesses

#### Scenario: Scan outcome remains unchanged
- **WHEN** the same filesystem and scan settings are used before and after explanatory diagnostics are added
- **THEN** the discovered repository paths and order, effective discovery decisions, and import selection remain the same

### Requirement: Use execution-host evidence with version-safe fallback

Explanations SHALL describe the selected execution host's paths and results for local, SSH, and paired runtime flows. Diagnostic response metadata SHALL be optional so independently updated clients and hosts remain compatible. Missing diagnostics MUST NOT be normalized into a verified zero-exclusion result, and unknown diagnostic reasons MUST NOT invalidate otherwise usable repository results.

#### Scenario: SSH or paired runtime returns diagnostics
- **WHEN** discovery runs on an SSH host or paired runtime and supplies diagnostics
- **THEN** the client displays those host-produced explanations without checking equivalent local paths

#### Scenario: Older host omits diagnostics
- **WHEN** a host returns the existing scan result without diagnostic metadata
- **THEN** repository results, classification, and existing limit flags remain usable
- **AND** the UI does not claim that no folders were excluded or invent matching rules

#### Scenario: Host sends an unfamiliar reason
- **WHEN** a newer host returns a directory reason that the client does not recognize
- **THEN** the client preserves repository results and degrades that explanation to neutral unavailable-detail text without granting new actions

### Requirement: Accessible and localized explanation presentation

Explanations SHALL use visible inline text and keyboard-operable expandable details with an announced expanded state. User-facing labels and reason copy SHALL be localized. Paths and rules SHALL remain literal data rendered as text, with long paths readable without obscuring the import controls.

#### Scenario: Keyboard reader inspects exclusions
- **WHEN** the user reaches the exclusion details control with the keyboard and expands it
- **THEN** the expanded state is announced and the paths and reasons can be read without hovering
- **AND** the existing import, open, and cancel controls remain reachable
