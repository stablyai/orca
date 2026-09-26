# Release completed nested-repository scan records

`scanNestedRepos` kept every consumed `TraversalFolder` in its breadth-first queue until the scan finished. Those records retained path segments and inherited parsed ignore rules after their directories had been processed. Releasing each consumed slot and occasionally compacting the empty prefix removes that temporary retention while preserving traversal order.

## Run

```sh
ORCA_BACKGROUND_LAUNCH=1 node docs/audits/nested-repo-processed-queue/reproduce.cjs
```

The runner uses the repository's process launcher to start a Node child with forced GC, a 256 MiB old-space limit and a 15-second timeout. It bundles the actual scan and ignore-rule parser. An observational hook records weak references and scalar queue counts. A finite injected filesystem pauses one directory read; no app window, PTY, SSH connection or native watcher starts. The unused local Git detector is a throwing stub, ensuring the injected filesystem owns every probe.

The fixture has 96 branches, each with 64 distinct ignore rules and one child directory. It pauses the penultimate child read, leaving one pending directory. Four event-loop-separated GC rounds precede each observation.

| Observation                                |  Before | Slot-release control |  Fixed |
| ------------------------------------------ | ------: | -------------------: | -----: |
| Completed child records surviving GC       | 94 / 94 |               0 / 94 | 0 / 94 |
| Their inherited rule arrays surviving GC   | 94 / 94 |               0 / 94 | 0 / 94 |
| Observed records surviving scan completion |       0 |                    0 |      0 |
| Total directories visited                  |     193 |                  193 |    193 |

All variants visit the same directories in exactly the same order and return the same empty result. The baseline reverses only `fix.patch` in memory. The diagnostic control adds only consumed-slot clearing to that baseline, without compaction; it isolates the retaining path. The fixed variant executes the current queue implementation. `results.json` includes source hashes, exact queue counts, runtime provenance, process exit and timeout status.

The narrow source regression suite exercises a wider traversal across repeated compaction, including Windows and SSH POSIX path forms, inherited ignore rules, breadth-first result order, maximum depth, repository caps, cancellation and optional timeout behavior. All 37 discovery, queue and scan-rule tests passed, along with Node typechecking and focused lint checks. Existing discovery tests cover local filesystem and symlink behavior.

## Reuse and scope

The change follows the consumed-slot release pattern in `ws-outbound-backpressure-queue.ts` and the amortized prefix compaction pattern in `runtime-rpc-call-queue.ts`. It introduces no new queue abstraction, traversal policy, RPC field or host boundary.

The baseline source matches `v1.4.198`; the runner verifies this named-tag comparison after normalizing CRLF line endings to LF for Windows checkout portability. This is not an execution of the historical packaged application.

The IPC route uses this scanner for local and SSH-backed folder selection, with filesystem operations delegated to the selected host. Runtime scan/import routes request a 15-second timeout; IPC forwards options, whose timeout defaults to null. Existing time checks happen between awaited operations and do not cancel a pending read.

This fix releases completed work. It does not cap the active frontier, directory entry arrays, `.gitignore` size or directory breadth. The original implementation releases its records on scan completion. No heap-byte savings or field-incident attribution is claimed; no affected-host data was used.
