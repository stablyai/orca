// Why: protocol v22 is the first daemon that verifies the full POSIX process tree or Windows
// ConPTY exit before teardown completes; older daemons cannot make that safety guarantee.
export const VERIFIED_FULL_SESSION_TEARDOWN_PROTOCOL_VERSION = 22

// Why: protocol v22 is also the first daemon that applies the host-side Git credential guard.
export const GIT_CREDENTIAL_GUARD_HOST_PROTOCOL_VERSION = 22
