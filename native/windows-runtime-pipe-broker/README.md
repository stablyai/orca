# Windows runtime pipe broker candidate

This candidate owns a public `\\.\pipe\orca-broker-*` endpoint with a
protected DACL and forwards one duplex byte stream to one exact private Orca
instance. The trusted parent supplies an instance id, its own PID, the runtime
id, and one deadline over inherited stdin. The broker rejects command-line
configuration, verifies that the server PID is its real parent, and derives the
private endpoint from the same `PID + runtimeId` rule as Orca.

The broker grants `ReadWrite | Synchronize` (`0x12019B`) from local
server-side policy and never accepts a client-supplied SID. The owner selects
one explicit local account through
`ORCA_EXPERIMENTAL_WINDOWS_PIPE_BROKER_SANDBOX_ACCOUNT`. The broker resolves
that name through Windows `LookupAccountNameW`, requires the computer-local
domain and `SidTypeUser`, and places only that returned SID in the client ACE.
SID strings, groups, remote domains, and client declarations are rejected.

Activation is off unless `ORCA_EXPERIMENTAL_WINDOWS_PIPE_BROKER=1`. Enabling
it without the explicit sandbox-account setting fails startup. Existing
runtime request authentication remains mandatory after OS-level access; the
focused oracle sends a valid credential and an invalid credential through the
same allowed transport and requires the invalid request to return
`unauthorized`.

One deadline covers accept, private connect, and duplex forwarding. Supervisor
exit, interrupted copying, missing request/response bytes, timeout, and
unverified shutdown return nonzero. The broker has no descendants.

## Release integrity and signature

The Windows `afterPack` hook reads
`resources/bin/orca-pipe-broker.exe` back from the generated application
tree, compares its SHA-256 with the native build output, and executes the
packaged copy. A missing, changed, or non-executable binary fails packaging;
`extraResources` configuration alone is not evidence.

Before promotion, the broker itself must be Authenticode-signed by the approved
Windows release identity. The release job must run:

```text
signtool verify /pa /all /v <resources>\bin\orca-pipe-broker.exe
```

Record signer subject, certificate thumbprint, SHA-256, timestamp result, and
exit code. Any nonzero result blocks release. An installer signature does not
prove the nested executable is signed. Local and development builds may remain
unsigned, but are not promotable evidence.

## Known identity limit

The same-account test denies creation of another pipe instance, deletion, and
ownership takeover. It cannot prove denial of `WRITE_DAC`: a Windows object
owner retains that right even when a deny ACE is present. The prepared
cross-account test must establish a normal-user server owner and a distinct
sandbox SID before promotion. Passing that transport gate alone does not enable
the feature; the flag remains off until the RPC and lifecycle gates also pass
independent review.

## Cross-account test handoff

Commit the candidate before this test. In a normal, non-sandboxed PowerShell,
run `node config/scripts/prepare-windows-runtime-pipe-cross-account-test.mjs`
with `--authorized-account "$env:COMPUTERNAME\CodexSandboxOffline"`.

The script prints the normal server account/SID, the Windows-resolved authorized
sandbox SID, exact rights, and a client command. Within 30 seconds, run that
printed command inside the real sandbox. The client prints its account, primary
SID, restrictive SIDs, and the RPC result.

The test uses random `orca-broker-*` and private `orca-*` endpoints owned by
the test, one random capability, and a 30-second absolute deadline. The handoff
file is created exclusively and deleted in `finally`; the broker watches its
normal-user supervisor and has no child processes. No installed Orca endpoint,
process, token, configuration, or ACL is read or changed.

Required result:

- `SERVER_ACCOUNT != CLIENT_ACCOUNT`
- `SERVER_SID != CLIENT_SID`
- `AUTHORIZED_SANDBOX_SID == CLIENT_SID`
- `CLIENT_RESTRICTED_SID` includes `CLIENT_SID`
- `CROSS_ACCOUNT_RPC=PASS RIGHTS=0x12019B`
- `BROKER_EXIT=0`

Observed at candidate `c132f9e639f817af64f1012168fa38ea55634b18`
(reported by the independent cross-account run, not rerun by the constructor):

- server and client ran under distinct local Windows accounts and distinct SIDs;
- the sandbox client's primary SID was explicitly authorized and was also present among its restrictive SIDs;
- the Windows-resolved authorized SID matched the client primary SID, which was
  also present among the client's restrictive SIDs;
- `CROSS_ACCOUNT_RPC=PASS RIGHTS=0x12019B`, client exit `0`, broker exit `0`.

This is limited acceptance of identity selection and transport. It does not
approve Orca RPC authentication or lifecycle continuity. Those are separate
gates exercised by the isolated real-handler integration test.

## Concurrency contract

The experimental broker serves exactly one public RPC session at a time and
does not maintain an application-level queue. While that session is active, a
concurrent Windows open is rejected by the named-pipe subsystem with
`ERROR_PIPE_BUSY` (231). The caller must retry explicitly within its own
deadline. The active session uses the single configured session deadline for
accept, private connect, both copy directions, and thread settlement; there is
no independent two-second join cap.

## Isolated real-handler integration test

Build the broker and CLI, set `ORCA_TEST_WINDOWS_PIPE_ACCOUNT` from
`[Security.Principal.WindowsIdentity]::GetCurrent().Name`, then run
`src/main/runtime/windows-runtime-pipe-broker-rpc.integration.test.ts`. The
test creates a fresh temporary user-data directory and random private/public
pipes, invokes the compiled CLI `status --json`, sends a second request with an
invalid token, kills the broker after READY, and requires the named-pipe entry
to disappear from the live metadata. Its 30-second test timeout is the outer
deadline. This isolated same-account run validates handler/CLI/lifecycle only;
it does not replace the distinct-account evidence above.
