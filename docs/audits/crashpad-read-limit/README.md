# Crashpad bounded reads

After a crash, Orca extracts a short diagnostic signature from a potentially large dump.
The old reader loaded the complete dump. The current parser reads bounded ranges through
four retained 64 KiB pages and scans embedded diagnostic text in roughly 1 MiB windows.
It can capture a report that grows beyond the existing 64 MiB directory-discovery limit
without keeping that report in one large buffer. Reports already beyond that limit when
discovered retain the existing exclusion policy.

## Reproduction

```sh
ORCA_BACKGROUND_LAUNCH=1 node docs/audits/crashpad-read-limit/reproduce.mjs
```

Use the repository's installed dependencies and supported Node version. The runner checks
committed SHA-256 values in `source-hashes.json` before executing any tests. This includes
the capture/parser, test fixtures, runner and its local imports, plus package and lockfile
versions. It refuses changed sources instead of silently recording new hashes. Updating
the manifest requires reviewing the changed evidence and rerunning the proof.

The runner executes the actual capture and file-source tests with synthetic files, then
repeats them with only the zero-size extent deadline disabled through an in-memory Vite
transform. The mutation changes no files. This is a regression control for the deadline,
not a simulation of every behavior in the original implementation.

| Phase                  | Pass | Fail | Skip | Exit |
| ---------------------- | ---: | ---: | ---: | ---: |
| Deadline removed       |   24 |    2 |    0 |    1 |
| Current implementation |   26 |    0 |    0 |    0 |

The two expected failures verify that a file reported as size zero stops being read at
the deadline, after either one or two pages, even though more bytes remain available.
The controls fail both on the observed extent and the number of actual file reads.
The runner checks their exact names and exits unsuccessfully for unexpected results.
`results.json` records the verified hashes, counts, failed cases, exit codes and timeouts.

Other controls cover 80 MiB sparse dumps, metadata beyond 64 MiB, marker/check-message
boundaries, growth and replacement during capture, zero-size growth, truncation, descriptor
cleanup and partial-header retry behavior. A symlink swap, deleted candidate, or directory replacement now skips only that candidate; another valid dump can still supply the signature. The symlink-swap test is skipped on platforms without `O_NOFOLLOW`. The largest requested parser read is 1 MiB +
4,096 bytes, plus four retained 64 KiB metadata pages. A 1,042-module fixture requires no
more than eight reads, preventing repeated reads between module and name pages.

## Parser compatibility

```sh
ORCA_BACKGROUND_LAUNCH=1 node docs/audits/crashpad-read-limit/stream-signature-parity.cjs
```

The separate parity script compares 47 fixtures with the published parser at
`09dbe227547fadaec8d9163f35fd127b0dc1c3ed`, using both in-memory buffers and real file handles.
It covers annotations, modules, exceptions, chunk boundaries and marker exhaustion. It
also prints five warm timings for 8/64 MiB sparse dumps; these local synthetic timings
are not a platform-wide performance guarantee. This older parity script does not enforce
the source manifest; use the manifest-checking regression runner first.

## Limits and user impact

This removes a potentially large transient allocation after a crash; it does not establish
the cause of normal-session OOMs or an aggregate process-memory cap. Independent captures
can overlap. No evidence ties this file-growth race to #19831 or #19768.

The opened file supplies the parsed ranges. In-place rewrites are not an atomic snapshot.
Nonempty files retain their opened extent. A file opened at size zero receives at least one
read, then observes growth only until the capture deadline; later bytes may therefore be
omitted from that diagnostic signature. This keeps a continuously growing report from
holding capture open indefinitely. Dump files themselves are not truncated by this reader.

Crashpad normally writes an invalid header first and promotes a completed file later:
[database implementation](https://chromium.googlesource.com/crashpad/crashpad/+/refs/heads/main/client/crash_report_database_mac.mm)
and [minidump writer](https://chromium.googlesource.com/crashpad/crashpad/+/HEAD/minidump/minidump_file_writer.cc).
The fixtures represent that ordering; they do not reproduce a field incident or a native
Crashpad process. All checks run in background Node processes without app windows.
