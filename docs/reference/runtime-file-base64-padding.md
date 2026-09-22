# Runtime file Base64 padding

Padded runtime file writes must have a length divisible by four. Empty strings and
unpadded Base64 with length modulo four equal to zero, two, or three remain valid.
The change rejects exactly the previously accepted strings containing trailing
padding whose total length modulo four is two or three. It does not enforce
canonical unused pad bits or change the alphabet.

## Boundary evidence

| Input                     | Before | After  |
| ------------------------- | ------ | ------ |
| `A=`                      | Accept | Reject |
| `AA==`                    | Accept | Accept |
| `AAA=`                    | Accept | Accept |
| `AAAA`                    | Accept | Accept |
| `''`                      | Accept | Accept |
| `A`                       | Reject | Reject |
| `==`                      | Accept | Reject |
| `AA=A` (interior padding) | Reject | Reject |
| `AA=`                     | Accept | Reject |
| `A==`                     | Accept | Reject |
| `AAAA==`                  | Accept | Reject |
| `AA`, `AAA` (unpadded)    | Accept | Accept |

`Buffer.from('A=', 'base64')` decodes to zero bytes. Rejecting malformed padding at
the RPC boundary prevents an accepted request from silently writing different bytes.

## Caller census

| Caller / surface                                                                                       | Reachability and compatibility verdict                                                                                                                                                                                                                                                                                                  |
| ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Desktop `runtime-file-import-client.ts` → `uploadRuntimeFileWithoutClobber` → `writeRuntimeBase64File` | The only production producer of `files.writeBase64` and `files.writeBase64Chunk`. Staging in `filesystem-runtime-upload-staging.ts` encodes the complete file with `buffer.toString('base64')`; newly rejected values cannot be produced.                                                                                               |
| Desktop single-frame uploads                                                                           | Sends the staged string unchanged when its length is at most 512 × 1024 characters. Standard Node Base64 always has length divisible by four. Empty files remain accepted.                                                                                                                                                              |
| Desktop chunked uploads                                                                                | Slices the encoded stream at 512 × 1024 = 524,288 characters, divisible by four. Every offset and every complete chunk is quartet-aligned. The final chunk is the difference of two multiples of four, including when it ends in `=` or `==`. No separately assembled final chunk or per-chunk padding is added.                        |
| Web implementation of `stageExternalPathsForRuntimeUpload`                                             | Returns an empty source list; no file-write payload is produced.                                                                                                                                                                                                                                                                        |
| Mobile file editor                                                                                     | Uses `files.writeTerminalArtifact` with text content and its separate schema. Does not reach this predicate.                                                                                                                                                                                                                            |
| Mobile clipboard / image attachments                                                                   | Uses `clipboard.startImageUpload`, `clipboard.appendImageUploadChunk`, `clipboard.commitImageUpload`, and the `clipboard.saveImageAsTempFile` fallback. Their validator is `isValidBase64` in `clipboard-params.ts`, not `isValidRuntimeFileBase64`. Unchanged, including the mobile normalizer's existing permissive padding behavior. |
| CLI                                                                                                    | No producer of either Base64 file-write method. File commands in `src/cli/handlers/file.ts` call `files.open` / `files.openDiff`; other CLI RPC call sites do not construct Base64 file writes.                                                                                                                                         |
| Generated params catalog                                                                               | References both schemas; `RpcParams` consumers use inferred types. Mobile's entry point is `export type` only, so no new client-side parsing occurs.                                                                                                                                                                                    |
| RPC dispatch                                                                                           | `files-mutation-methods.ts` registers both schemas. The chunk schema extends the whole-file schema; these are the only runtime consumers of the predicate. Direct runtime/provider calls do not parse these schemas.                                                                                                                    |

Repository-wide searches covered method names, schema names, the predicate and its
pattern, and all callers of the upload/staging functions. Targeted history search
on `HEAD` under `mobile/src` found no introduction/removal of the affected methods
or predicate. The local release refs `mobile-ios-v0.0.27` and `mobile-v0.0.13` also
contain no callers of either Base64 file-write method; the iOS ref uses the separate
clipboard and terminal-artifact methods above. No shipped mobile producer of a
newly rejected value was found in this source/history audit.

## Remote and workspace compatibility

Old desktop clients using the audited producer send valid quartets to a new host.
A new client still sends the same bytes to an old host. No method, field, opcode,
or host-published content changes. This follows the mixed-version requirements in
[remote-wire-compatibility.md](./remote-wire-compatibility.md).

The RPC validation runs before workspace resolution and provider selection, so the
same rule applies to folder workspaces, git worktrees, local hosts, and SSH hosts.
SSH ownership fences and provider writes are unchanged. Arbitrary external RPC
callers sending malformed padding will now receive a validation error; valid
padded and unpadded payloads remain accepted.

## Regression evidence

`src/main/runtime/rpc/methods/files-base64-padding.test.ts` exercises both actual RPC
registrations, asserts rejected input never reaches the writer, and verifies
accepted content is forwarded unchanged. With the original predicate, the test
run produced **16 failed / 16 passed**; all 16 failures were newly rejected padding
shapes accepted by the old implementation. This was run before editing the predicate.

The existing desktop external-import test now uses a final `AA==` chunk after a
524,288-character first chunk, pinning padded final-chunk forwarding in the real
upload path. No producer changes or clipboard validation changes were necessary.

## Validation results

All test/typecheck commands used `ORCA_BACKGROUND_LAUNCH=1`.

- `pnpm tc`: exit 0; all root typecheck projects passed.
- `pnpm exec vitest run src/main/runtime/rpc`: 277 files passed, one failed;
  2,419 tests passed, two timed out, one skipped. Both timeouts were in the unchanged
  `terminal-output-frame-chunks-equivalence.test.ts` (5s surrogate-range test and
  30s 800-payload fuzz test).
- `pnpm --dir mobile typecheck`: exit 0 (`tsc --noEmit`).
- `pnpm run check:code-quality:changed`: exit 0; code quality, type-aware code
  quality, and React Doctor each reported zero new findings across three source files.
- Focused run with `--config config/vitest.config.ts --maxWorkers=2`: all three
  files / 58 tests passed, covering padding, desktop external imports, and the
  terminal-output equivalence file that timed out in the initial run.
- Full RPC rerun with `--maxWorkers=2`: exit 0; all 278 files passed,
  2,421 tests passed and one skipped (198.34s). No timeout overrides were needed.
