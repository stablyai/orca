# TASK-BE-007: `VerifiedSsoIdentity.Groups` + OIDC `groups` claim parsing

> **Status: ✅ DONE — 2026-09-09**

### Kết quả thực tế

- `VerifiedSsoIdentity.Groups []string` added in `ports.go`, with the doc comment exactly as specified.
- `oidc.go`: `oidcUserInfo` gained `Groups []string \`json:"groups"\`` (plus a doc comment noting the
  deployment's Keycloak client needs the `groups` mapper/scope enabled); `ExchangeAndVerify` forwards it
  into `VerifiedSsoIdentity.Groups`.
- `github.go`/`login_or_provision_sso_user.go` untouched (TASK-BE-008/010, not this task) — `Groups` is
  simply left at its zero value (nil) for the GitHub exchanger for now.
- `impact({target:"VerifiedSsoIdentity", direction:"upstream", repo:"orca"})`: 2 direct callers
  (`GitHubClient.ExchangeAndVerify`, `OidcClient.ExchangeAndVerify`), 1 module affected (`Oauth`), 0
  processes affected, **risk: LOW** — matches the task file's prediction exactly.
- Tests added: `TestOidcExchangeAndVerify_ParsesGroupsClaimWhenPresent`,
  `TestOidcExchangeAndVerify_AbsentGroupsClaimDoesNotError` in `oidc_test.go`.
- `go build ./services/auth-service/...` and `go test ./services/auth-service/...` both clean.
  `gofmt -l` clean on both changed files.

**Solution:** BE-SOL-003 | **CR:** CR-RBAC-003
**Depends on:** TASK-BE-003..006 (BE-SOL-002's role model must be final — this CR maps SSO groups to the
confirmed 2-tier `user`/`admin` global role, not a 3rd tier).

---

## Goal

`VerifiedSsoIdentity` has no `Groups` field, and `oidc.go`'s `ExchangeAndVerify` does not request or parse
a `groups` claim from the OIDC userinfo endpoint. Add both — this is the foundation TASK-BE-008
(GitHub) and TASK-BE-010 (role resolution) build on.

## What to do

1. `backend-go/services/auth-service/internal/usecase/ports.go`:

```go
type VerifiedSsoIdentity struct {
	Provider      domain.SsoProvider
	Subject       string
	Email         string
	EmailVerified bool
	Name          string
	// Groups is the IdP's group/org/team membership at login time — only
	// populated for providers this CR wires (OIDC/Keycloak via the `groups`
	// claim, GitHub via org/team membership REST calls). Empty for Google
	// (no group claim in a standard OIDC token — Directory API integration
	// is a documented, separate backlog item, not attempted here).
	Groups []string
}
```

2. `backend-go/services/auth-service/internal/adapter/oauth/oidc.go`: `oidcUserInfo` gains
   `Groups []string \`json:"groups"\``, and `ExchangeAndVerify` forwards it into
   `VerifiedSsoIdentity.Groups`.

3. Document (in a code comment near the userinfo decoding) that the deployment's Keycloak client must
   have the `groups` mapper enabled for this to populate — a config note, not a code gap.

## Acceptance Criteria

- [x] `VerifiedSsoIdentity` has a `Groups []string` field with the doc comment above.
- [x] `oidcUserInfo` parses `groups` from the userinfo response when present.
- [x] `ExchangeAndVerify` forwards `groups` into `VerifiedSsoIdentity.Groups`.
- [x] Empty/absent `groups` claim does not error — backward compatible with IdPs that don't send it.
- [x] `oidc_test.go`: new test asserting `ExchangeAndVerify` parses `groups` when present, and doesn't
      error when absent.
- [x] `go build ./...` / `go test ./...` clean for `auth-service`.

## gitnexus

Not run with numeric results in BE-SOL-003's pass. `codegraph_explore`'s blast-radius scan found 12
direct callers of `VerifiedSsoIdentity`, all within `auth-service`'s own `oauth`/`usecase` packages and
their tests — no cross-service consumer. Run
`impact({target:"VerifiedSsoIdentity", direction:"upstream"})` immediately before editing, per the repo's
mandatory rule; expected LOW risk.

## Blocking

Blocks TASK-BE-008 (adds to the same `Groups` field) and TASK-BE-010 (consumes `Groups`).
