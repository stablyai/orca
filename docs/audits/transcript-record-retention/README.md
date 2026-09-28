# AI Vault oversized transcript records

The local/WSL incremental JSONL reader accumulated every chunk of a newline-free
record, then concatenated and decoded the whole record at newline or EOF. Its
piece list avoided quadratic copying but did not bound memory. Both the reader
and the scanner child's 384 MiB V8 old-space setting exist in `v1.4.198`; that
heap setting does not impose a 384 MiB process RSS cap on external buffers.

The fix shares the existing streamed remote reader's 10 MiB record limit and
checks local bytes before retaining, concatenating, or decoding an oversized
record. It rejects that session read through the existing scan-issue path; it
does not silently discard records or advance the persisted resume point after
failure. A legitimate record larger than 10 MiB is therefore unavailable in that
scan. Large files containing many smaller records continue to work. This covers
the resumable JSONL route, not every whole-document/import reader.

## Reproduce

```sh
ORCA_BACKGROUND_LAUNCH=1 node --expose-gc docs/audits/transcript-record-retention/reproduce.mjs
```

The script writes a 64 MiB synthetic record in a temporary local file and bundles
the actual reader. Only the filesystem adapter is replaced with the equivalent
native `createReadStream` route plus a byte counter. The baseline removes the
three new budget checks in memory. Each case runs in its own Node process with
`--max-old-space-size=384`; both terminated and unterminated records are tested.
Temporary files are removed. [Results and bundle hashes](./results.json) were
captured on macOS with Node v26.6.0.

| Case                 | Bytes read | External allocation delta after read |   Peak RSS |
| -------------------- | ---------: | -----------------------------------: | ---------: |
| Before, unterminated | 67,108,864 |                          201,303,426 | 248.25 MiB |
| After, unterminated  | 10,551,296 |                           10,528,130 |  62.13 MiB |
| Before, terminated   | 67,108,865 |                          201,368,963 | 248.22 MiB |
| After, terminated    | 10,551,296 |                           10,528,130 |  62.16 MiB |

RSS includes runtime overhead; allocator behavior varies. The mechanism is the
unbounded record assembly and its copies, not the precise sample. Ordinary
terminated records can be reclaimed afterward; this is a peak-allocation/OOM
risk, not evidence of a permanent leak after each read.

Validation: 71 tests across five reader/remote/cache/WSL suites passed, then ten
tests across the reader and cache-recovery suites passed (nine overlap). The
regressions cover all three assembly paths, exact byte boundaries, Unicode,
large multi-record files, iterator cleanup, and unchanged cached resume state
followed by successful repair. Full typecheck, final node typecheck, lint, and
changed-code quality passed. Tests used `ORCA_BACKGROUND_LAUNCH=1`.

This is another reachable allocation mechanism within the app process group.
#19831 does not establish an oversized transcript record. In the reported build
normal scanning runs in a child, so this route does not explain #19768's isolated
main-PID measurement. No affected-host attribution is claimed.
