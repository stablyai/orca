# Client-hosted browser automation methods

`browser.clientHost.attach` accepts optional `supportedAutomationMethods`, using the
canonical `BROWSER_CLIENT_AUTOMATION_METHODS` names. The host echoes the normalized
set in `ready`. This is a restriction on the existing `automation-v1` capability,
not authorization to attach: authenticated runtime/device/connection checks and
mobile admission remain unchanged.

- Omitted: preserve existing desktop automation behavior, including `browser.exec`.
- Empty array: support no automation methods; page lifecycle commands remain available.
- Explicit set: support only those methods, subject to existing file-channel and
  execution-host requirements. Reject unsupported automation before ledger issue.

Names are case-sensitive; aliases and unknown names are rejected. Input length is
bounded by the canonical inventory size before duplicates are removed. Sets are
sorted, deduplicated, and copied into immutable lease state. Explicit sets require
both command protocol v1 and `automation-v1`.

An explicit set cannot contain `browser.exec`. It accepts raw agent-browser argv,
which cannot be fully checked against the canonical RPC method inventory. Rather
than advertise passthrough as supported, attach rejects that advertisement; callers
must use individual supported RPCs. Legacy omitted-set passthrough is unchanged.
The receiver independently rejects unsupported commands, ignoring any purported
entitlement in a command envelope.

Compatible reconnect requires the same set (order and duplicates do not matter).
Omission differs from an explicit empty or full set. An otherwise compatible
reconnect with a changed set fails with `browser_host_automation_methods_changed`
before changing the connection, owner, generations, routes, or command ledger.
Existing lease release, expiry, replacement, and page recovery retain their rules.

Old clients omit the field and retain legacy behavior with new hosts. A client
requesting an explicit set requires an exact normalized echo: an old host that
ignores the field cannot safely host that restricted client, so attachment fails.
No stream opcode, placement rule, or mobile capability is added.
