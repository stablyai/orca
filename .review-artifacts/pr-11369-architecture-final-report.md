# PR #11369 Architecture Final Report

## Decision

Reject candidate `f92db196a1d4c6cdefeb1d938b2f54b3a6a85e3e`.

## Finding

Active restored-editor reparenting switches `activeWorktreeId` while retaining source terminal, browser, pending-creation, and explorer state, and it bypasses centralized workspace-activation side effects. Reparenting must use the authoritative workspace-activation transaction with complete target projection, first-activation terminal generation preparation, and post-commit effects, without duplicating activation authority.

## Required regression

Reparent an active restored editor into an unactivated sibling and require one coherent target projection plus the same post-commit effects as ordinary activation, with no source workspace state retained.
