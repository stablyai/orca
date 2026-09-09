# BE-SOL-007: SAML `SsoExchanger` — preliminary design only (Backlog)

> **🔲 Proposed — Backlog.** This is intentionally a short, shallow design —
> per the CR itself, implementation should not start without product-owner
> confirmation that SAML is actually needed (most modern IdPs support OIDC,
> which is already fully built — see BE-SOL-003).

**CR:** [CR-RBAC-007](../../../../../../docs/crs/v4/team-rbac/CR-RBAC-007-saml-support.md)
**Service:** auth-service (new `internal/adapter/saml/`) + api-gateway (new ACS route)
**Depends on:** [BE-SOL-003](./BE-SOL-003-sso-group-mapping-and-session-refresh.md)
(group→role mapping table should be provider-agnostic before SAML reuses it
— confirmed already true, see BE-SOL-003 §7).

---

## 1. Confirmed: 0% SAML code exists

Consistent with the CR's own audit — no `saml` reference found in
`backend-go/` outside documentation. `internal/usecase/ports.go`'s
`SsoExchanger` interface (implemented today by `oidc.go` and `github.go`,
per `codegraph_explore`'s confirmed 2-implementation list) is the seam a
3rd implementation would plug into — this was verified structurally sound
for the purpose (both existing implementations return the same
`VerifiedSsoIdentity`, and `LoginOrProvisionSsoUser` is implementation-agnostic
per its own usage in both `oidc.go`/`github.go` test files).

## 2. Preliminary shape (not detailed further, per the CR's own recommendation)

- New `internal/adapter/saml/` package implementing `SsoExchanger`, using
  `crewjam/saml`'s `samlsp` service-provider primitives for XML
  signing/parsing rather than hand-rolling SAML crypto.
- Unlike OIDC (one authorization-code exchange call), SAML's `SsoExchanger`
  shape doesn't map 1:1 — `ExchangeAndVerify(code, redirectURI, codeVerifier)`
  assumes an OAuth2-shaped code exchange that SAML doesn't have (SAML's
  browser flow POSTs a signed assertion directly to the ACS endpoint, no
  server-to-IdP token exchange). **This means `SsoExchanger`'s interface
  itself likely needs to change** (e.g. split into "build redirect" +
  "verify assertion" methods generic enough for both shapes, or SAML gets a
  parallel, differently-shaped port) — flagged here as the first real design
  question to resolve before writing code, not resolved in this pass.
- New ACS (Assertion Consumer Service) HTTP endpoint at api-gateway,
  parallel to `GET /auth/callback` — verify exact routing conventions in
  `auth_routes.go` before implementing.
- Per-tenant SAML metadata (unlike OIDC's single shared discovery URL) needs
  its own config/table — likely `auth.sso_providers` or similar, not
  designed in this pass.
- Reuses BE-SOL-003's `sso_group_role_mapping` table for SAML attribute-based
  group equivalents (`provider = "saml"`, `group_name` = the mapped SAML
  attribute value) — confirmed compatible without schema changes, since
  `provider`/`group_name` are already plain strings, not an enum tied to
  OIDC/GitHub specifically.

## 3. Explicitly not designed further here

Signature verification, clock-skew handling, metadata exchange UI, and the
`SsoExchanger` interface split noted in §2 are all left to whoever picks
this up when/if product confirms the need — consistent with the CR's own
"Backlog, effort lớn, cần product owner xác nhận nhu cầu" framing. Writing a
full solution spec for a feature that may never be built is not a good use
of this pass's effort; this document exists mainly to record the one
concrete technical finding (§2's `SsoExchanger` shape mismatch) so the next
person doesn't have to rediscover it.

## 4. Impact analysis

Not applicable — no existing symbol is being modified; this is a
new-feature, backlog-only design note.
