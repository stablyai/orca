# Structured Agent Adapter Foundation

Issue [#10099](https://github.com/stablyai/orca/issues/10099) tracks the versioned external
adapter contract. This document scopes the first, behavior-preserving migration step.

## Phase 1

`NATIVE_CHAT_AGENT_ADAPTERS` is Orca's immutable built-in registry for Chat UI agent
policy. Each descriptor owns:

- agent identity and transcript-family aliasing;
- structured-question answer pacing;
- skill grammar and source owner;
- verified command-catalog policy.

`nativeChatTranscriptAdapterForAgent()` maps those descriptors to main-process line and
turn-lifecycle decoders. Readers, tailers, and watchers consume the adapter instead of
branching on provider IDs independently.

The registry rejects duplicate agent ownership and snapshots descriptors before exposing
them. Existing Claude, OpenClaude, Codex, and Grok behavior remains built in.

## Not Yet A Plugin Loader

Phase 1 does not discover packages or execute third-party code. In particular, it does not
expose renderer, Electron IPC, filesystem, or PTY primitives to adapters.

A later external contract must preserve these boundaries:

- executable adapters run outside the renderer;
- Orca owns desktop, Web, and mobile rendering from normalized data;
- filesystem and input operations execute on the runtime that owns the pane;
- provider-session identity remains separate from Orca pane and client identities;
- one active session owner/writer is authoritative;
- unsupported interactions request an explicit terminal handoff;
- adapter events are bounded, cancellable, and safe under disconnects.

## Adding A Built-In Adapter

A built-in integration should add one descriptor, its transcript adapter, and conformance
fixtures. If the integration needs a new transcript family, extend the
`NativeChatTranscriptAgent` union and the exhaustive main-process transcript adapter map.

Do not infer interaction policy from transcript family. Agents that share a transcript
format can still have different composer, question, command, or session semantics.
