# Durable Docs

Keep this folder for versioned reference docs that are meant to survive past a
single design or implementation pass.

## What Goes Here

- Stable reference material.
- Public-facing docs that are not part of the root README.
- Docs that other checked-in files link to.
- Telemetry availability notes that dashboard authors need after the original design or implementation branch is gone. See [Telemetry Availability](./telemetry-availability.md).

## What Stays Out

Ephemeral design notes, implementation sketches, and planning docs should stay as
local Markdown files under `docs/`. They are ignored by default so they do not get
checked in accidentally.
