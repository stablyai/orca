# Agent skill sharing upstream boundary

Status: proposed for formal engineering and legal review.

Date: 2026-08-11.

## Context

Orca needs private, durable, cross-machine skill sharing with bounded archive ingestion,
host-owned destination resolution, crash-safe transactions, provenance, and mixed-version remote
support. `vercel-labs/skills` exposes a CLI and does not provide the Cloud authorization or local
transaction contract Orca requires.

The behavioral assessment used upstream commit
`c6f69c631292444cc541ac6d91e2226b0ff247da`.

## Decision

Orca implements its package, Cloud, installation, provider-placement, and recovery behavior
independently. The upstream project is a behavioral reference only.

Do not copy or mechanically translate upstream source, tests, fixtures, registry entries, provider
path tables, comments, or documentation. Derive provider paths from official provider
documentation and verify them with real installations. Orca does not depend on the upstream CLI,
npm package, or an unsupported programmatic API.

If a future change proposes incorporating upstream material, stop and review the exact material,
license, attribution, notices, and maintenance implications before implementation or merge.

## Consequences

- Orca owns stability, security, compatibility, and maintenance of this narrower installer.
- There is no automatic upstream synchronization job.
- Similar behavior is acceptable when independently derived from requirements and official
  provider contracts; textual or structural copying is not.
- Provider registry changes require normal code review plus official-documentation and real-host
  evidence.
- The pull request template requires reviewers to confirm this boundary for relevant changes.

## Review record

Product chose the reference-only approach during planning. Formal engineering and legal reviewers
remain to be named before external rollout.
