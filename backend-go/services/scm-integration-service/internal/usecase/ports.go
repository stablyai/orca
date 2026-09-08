// Package usecase holds scm-integration-service's application services and
// the ports they need — defined here, implemented in internal/adapter/*,
// per the Dependency Inversion convention in
// specs/backend-go/architecture/03-clean-architecture-guidelines.md.
//
// usecase/ code never imports a provider package (github, gitlab, ...)
// directly — it depends only on the ScmProvider interface below, handed the
// right implementation by ProviderRegistry, itself wired by
// cmd/server/main.go's composition root. That's what turns a future
// multi-provider fan-out (e.g. CheckHostedReviewEligibility, not in this
// scaffold's RPC surface) into a loop over one interface instead of one
// hand-copied branch per provider — see scm-integration-service.md §6.
package usecase

import (
	"context"
	"time"

	"github.com/stablyai/orca-go/services/scm-integration-service/internal/domain"
)

// Credential is the resolved per-tenant OAuth token for one provider call.
// It is deliberately the only place a token value lives outside an
// adapter's own HTTP auth-header construction — never logged, never
// persisted, never cached beyond a single usecase Execute call, per
// scm-integration-service.md §9 ("no shared, service-wide, or process-wide
// credential — a structural guarantee, not a runtime check").
type Credential struct {
	Token string
}

// IssueFilter narrows a ListIssues call. Empty State means "all states".
type IssueFilter struct {
	State string
}

// CreatePullRequestInput is the provider-facing input for opening a new
// pull/merge request.
type CreatePullRequestInput struct {
	Title      string
	Body       string
	HeadBranch string
	BaseBranch string
}

// ScmProvider is the port each concrete provider adapter
// (internal/adapter/{github,gitlab,bitbucket,azuredevops,gitea}) implements
// — see scm-integration-service.md §4/§6. Every method takes its Credential
// as an explicit parameter (never a field on the adapter itself) so there is
// no way for one tenant's call to accidentally reuse another tenant's
// resolved token.
type ScmProvider interface {
	ListIssues(ctx context.Context, cred Credential, repo string, filter IssueFilter) ([]domain.Issue, error)
	CreatePullRequest(ctx context.Context, cred Credential, repo string, input CreatePullRequestInput) (domain.PullRequest, error)
	ListPullRequests(ctx context.Context, cred Credential, repo string) ([]domain.PullRequest, error)
	GetRateLimitStatus(ctx context.Context, cred Credential) (domain.RateLimitStatus, error)

	// MergePullRequest / RequestPullRequestReviewers / RemovePullRequestReviewers
	// / SetPullRequestAutoMerge / UpdateIssue — see SOL-012 shape 1. GitHub
	// implements all five for real (TASK-075); other adapters return their
	// own package-level ErrCapabilityUnsupported sentinel until wired,
	// mirroring the azuredevops/gitea precedent already in this codebase.
	MergePullRequest(ctx context.Context, cred Credential, repo string, number int32, input MergePullRequestInput) (domain.PullRequest, bool, string, error)
	RequestPullRequestReviewers(ctx context.Context, cred Credential, repo string, number int32, reviewerLogins, teamSlugs []string) (domain.PullRequest, error)
	RemovePullRequestReviewers(ctx context.Context, cred Credential, repo string, number int32, reviewerLogins []string) (domain.PullRequest, error)
	SetPullRequestAutoMerge(ctx context.Context, cred Credential, repo string, number int32, enabled bool, mergeMethod string) (domain.PullRequest, error)
	UpdateIssue(ctx context.Context, cred Credential, repo string, number int32, patch IssuePatch) (domain.Issue, error)

	// UpdatePullRequest — github.updatePRTitle (SOL-012). Plain (repo,
	// number) address + a PullRequestPatch mirroring IssuePatch's
	// nil-means-unchanged convention. GitHub implements it for real
	// against PATCH /repos/{owner}/{repo}/pulls/{number}; every other
	// adapter returns its own ErrCapabilityUnsupported, same convention as
	// this block's other methods.
	UpdatePullRequest(ctx context.Context, cred Credential, repo string, number int32, patch PullRequestPatch) (domain.PullRequest, error)

	// StarRepository — github.starOrca (SOL-012). GitHub implements it for
	// real against PUT /user/starred/{owner}/{repo}; every other adapter
	// returns its own ErrCapabilityUnsupported, same convention as the
	// block above.
	StarRepository(ctx context.Context, cred Credential, repo string) (bool, error)

	// GetPullRequestForBranch — provider-generic; backs github.prForBranch
	// AND hostedReview.forBranch (SOL-014). found=false + zero-value
	// PullRequest means "no open PR/MR for this branch", not an error.
	GetPullRequestForBranch(ctx context.Context, cred Credential, repo, headBranch string) (pr domain.PullRequest, found bool, err error)
	// ResolveRepoSlug — github.repoSlug. Resolves candidate (a remote URL,
	// "owner/name", or bare name) to a canonical owner/name pair.
	ResolveRepoSlug(ctx context.Context, cred Credential, candidate string) (owner, name string, err error)

	// BranchExists — a plain existence read every provider's REST API
	// supports uniformly, unlike SOL-012/SOL-013's provider-specific
	// additions. Backs CheckHostedReviewEligibility's step 2 (SOL-014).
	BranchExists(ctx context.Context, cred Credential, repo, branch string) (bool, error)
}

// MergePullRequestInput carries the merge-method/commit-message fields
// MergePullRequest needs beyond repo+number.
type MergePullRequestInput struct {
	MergeMethod   string
	CommitTitle   string
	CommitMessage string
}

// IssuePatch is UpdateIssue's partial-update shape — nil pointer fields mean
// "leave unchanged", mirroring UpdateIssueRequest's proto3 `optional` fields.
type IssuePatch struct {
	Title        *string
	Body         *string
	State        *string
	AddLabels    []string
	RemoveLabels []string
	Assignees    []string
}

// PullRequestPatch is UpdatePullRequest's partial-update shape — nil
// pointer fields mean "leave unchanged", same convention as IssuePatch.
// Title-only today (github.updatePRTitle's actual wire shape); additive
// fields (Body, Base, State) can be added later without a breaking change,
// mirroring how IssuePatch itself grew incrementally.
type PullRequestPatch struct {
	Title *string
}

// WorkItemFilter narrows a ListWorkItems call — a small, deliberately
// partial subset of the legacy desktop backend's GitHub search-syntax
// grammar (parseTaskQuery in backend/src/shared/task-query.ts): scope/
// state/labels/assignee/author only. Explicitly NOT ported for v1 (see
// docs/execution-plan.md's github.listWorkItems entry): "@me" (needs a
// resolved current-user login — this service's CredentialResolver is
// (tenantID, provider)->one shared token, not per-viewer identity),
// review-requested:/reviewed-by:, free-text search (needs GitHub's Search
// API, a different endpoint/response shape), and cursor pagination
// (Before). Unrecognized/unsupported query tokens are silently ignored
// rather than erroring, matching this codebase's established
// documented-gap convention.
type WorkItemFilter struct {
	Scope    string // "all" | "issue" | "pr"
	State    string // "open" | "closed" | "merged" | "all"
	Labels   []string
	Assignee string
	Author   string
	Limit    int
}

// WorkItemProvider is implemented only by adapters that support the
// combined issue+PR "work items" listing feature — GitHub today. Kept as
// its own interface (rather than a new ScmProvider method) so the other
// four provider adapters (GitLab, Bitbucket, Azure DevOps, Gitea) don't
// need a stub method just to keep compiling; ListWorkItems' usecase type-
// asserts the resolved ScmProvider against this interface and returns
// SCM_WORK_ITEMS_UNSUPPORTED for providers that don't implement it.
type WorkItemProvider interface {
	ListWorkItems(ctx context.Context, cred Credential, repo string, filter WorkItemFilter) ([]domain.WorkItem, error)
}

// ProviderRegistry resolves which concrete ScmProvider implementation to use
// for a given provider enum value. cmd/server/main.go's composition root
// registers one entry per adapter package; usecase/ code never imports a
// provider package directly (§6).
type ProviderRegistry interface {
	Resolve(provider domain.ScmProvider) (ScmProvider, error)
}

// CredentialResolver represents the call to credential-broker-service that
// resolves this tenant's OAuth token for the given provider, before every
// provider call (§7/§9).
//
// STUB — credential-broker-service doesn't exist as a running service in
// this scaffold; internal/adapter/credentialbroker holds the stub
// implementation. Replace it with a real gRPC call to
// credential-broker-service before this service is deployed anywhere real
// tenant credentials matter — see scm-integration-service.md §7.
type CredentialResolver interface {
	Resolve(ctx context.Context, tenantID string, provider domain.ScmProvider) (Credential, error)
}

// OAuthToken is what a provider's token endpoint hands back after a
// successful authorization-code exchange (§9.1) — deliberately narrower
// than Credential (no notion of "resolved for this call"): this is the
// value about to be written to credential-broker-service, not one already
// resolved from it.
type OAuthToken struct {
	AccessToken string
	Scope       string
}

// OAuthExchanger performs the provider-side half of the OAuth
// authorization-code flow (§9.1): building the authorization URL the
// browser is redirected to, and exchanging a callback code for an access
// token. Kept as its own interface — separate from ScmProvider — because
// "authenticate with this provider" and "call this provider's data API"
// are different capabilities; folding both onto ScmProvider would force
// every fake/adapter in ListIssues-style tests to also grow OAuth methods
// they don't exercise.
type OAuthExchanger interface {
	// AuthorizationURL builds the URL to redirect the browser to. No
	// network call — pure string construction from state/redirectURI.
	AuthorizationURL(state, redirectURI string) string
	// ExchangeCode calls the provider's token endpoint for real.
	ExchangeCode(ctx context.Context, code, redirectURI string) (OAuthToken, error)
}

// OAuthExchangerRegistry resolves which OAuthExchanger to use for a given
// provider — mirrors ProviderRegistry's shape/rationale (see its doc
// comment) for the same reason: usecase/ code never imports a provider's
// OAuth adapter directly.
type OAuthExchangerRegistry interface {
	Resolve(provider domain.ScmProvider) (OAuthExchanger, error)
}

// OAuthState is the payload carried by StartOAuthFlow's opaque state token
// and recovered by CompleteOAuthFlow — see OAuthStateCodec's doc comment
// for why this is a signed token rather than a persisted row.
type OAuthState struct {
	TenantID    string
	UserID      string
	Provider    domain.ScmProvider
	RedirectURI string
	ExpiresAt   time.Time
}

// OAuthStateCodec creates and verifies the state token exchanged during the
// OAuth flow. Stateless (signed, not looked up) by design: this service's
// own data model (scm-integration-service.md §5) deliberately holds only
// rate_limit_cache/webhook_delivery_log — no oauth_state table — so the
// state token itself carries everything CompleteOAuthFlow needs, integrity-
// protected against tampering by whatever signing scheme the implementation
// uses (see internal/adapter/oauthstate).
type OAuthStateCodec interface {
	Encode(state OAuthState) (string, error)
	// Decode verifies the token's signature and expiry, returning an error
	// for a tampered, expired, or malformed token — CompleteOAuthFlow must
	// treat any Decode error as a rejected callback, never a best-effort
	// partial decode.
	Decode(token string) (OAuthState, error)
}

// CredentialWriter is this service's one write path into
// credential-broker-service — used only by CompleteOAuthFlow, once the
// authorization-code exchange succeeds, to persist the resulting token
// (WriteCredential, category CREDENTIAL_CATEGORY_SCM_OAUTH, owner_id =
// provider name — same convention CredentialResolver's doc comment already
// establishes for reads). Kept as a separate interface from
// CredentialResolver (read-only) so no other usecase in this service can
// acquire write access by accident.
type CredentialWriter interface {
	Write(ctx context.Context, tenantID string, provider domain.ScmProvider, token OAuthToken) error
	// WriteRaw is SetIntegrationCredential's entry point — a manually
	// pasted token, never exchanged from an authorization code, so it
	// carries no OAuthToken.Scope. Reuses the same
	// CREDENTIAL_CATEGORY_SCM_OAUTH / owner_id=provider-name slot Write
	// already writes to.
	WriteRaw(ctx context.Context, tenantID string, provider domain.ScmProvider, token, configJSON string) error
}

// CredentialStatusReader backs GetIntegrationCredentialStatus — metadata
// only, via credential-broker-service's GetCredentialMetadataByOwner RPC
// (TASK-038), never ResolveCredentialByOwner (which would leak plaintext
// for a status check).
type CredentialStatusReader interface {
	GetStatus(ctx context.Context, tenantID string, provider domain.ScmProvider) (configured bool, configJSON string, err error)
}

// CredentialLister backs ListIntegrationCredentials via
// credential-broker-service's ListCredentialsByCategory RPC (TASK-038).
type CredentialLister interface {
	ListConfiguredProviders(ctx context.Context, tenantID string) ([]domain.ScmProvider, error)
}

// CredentialRevoker is this service's disconnect path into
// credential-broker-service — used only by RevokeAuth, via
// RevokeCredentialByOwner (category CREDENTIAL_CATEGORY_SCM_OAUTH,
// owner_id = provider name — same convention CredentialResolver/
// CredentialWriter already establish). This service is only ever handed
// (tenantID, provider), never an opaque credential_id (see
// CredentialResolver's doc comment), so RevokeCredential's by-id RPC was
// never reachable from here — RevokeCredentialByOwner closes that gap. Kept
// as its own interface, not folded into CredentialWriter, for the same
// "no usecase acquires an unrelated capability by accident" reasoning
// CredentialWriter's doc comment gives.
type CredentialRevoker interface {
	RevokeByOwner(ctx context.Context, tenantID string, provider domain.ScmProvider) error
}

// RateLimitCache backs GetRateLimitStatus with a local read-through/
// write-through cache — scm-integration-service.md §8: "populated from
// response headers on every call; read before dispatching a burst of new
// calls to decide whether to back off... not a source of truth." Backed by
// the scm.rate_limit_cache table (migrations/0001_init.up.sql) as of Phase
// 3 (docs/execution-plan.md §3). Scoped to GetRateLimitStatus only for
// now — wiring every OTHER usecase (ListIssues/CreatePullRequest/
// ListPullRequests) to also populate this cache from their own responses'
// rate-limit headers, and to check it proactively before a burst of calls,
// is a larger, not-yet-scoped change — see this service's README "Known
// gaps".
type RateLimitCache interface {
	// Get returns the cached snapshot for (tenantID, provider) if one was
	// recorded within freshWithin of now. ok=false covers both a cache miss
	// and a snapshot older than that window — either way the caller must
	// fall back to a live provider call.
	Get(ctx context.Context, tenantID string, provider domain.ScmProvider, freshWithin time.Duration) (status domain.RateLimitStatus, ok bool, err error)
	Set(ctx context.Context, tenantID string, provider domain.ScmProvider, status domain.RateLimitStatus) error
}

// ProjectFieldValue is a generic key/value field write — mirrors
// scmintegrationv1.ProjectFieldValue 1:1 (Kind: "text" | "number" | "date" |
// "single_select" | "iteration"). See this file's package doc comment for
// why GitHubProjectsProvider is a separate interface from ScmProvider.
type ProjectFieldValue struct {
	FieldID string
	Kind    string
	Value   string
}

// Project, ProjectView, ProjectItem, IssueType, AssignableUser, Label,
// ProjectComment, WorkItemDetails mirror their scmintegrationv1 message
// counterparts 1:1 (TASK-077) — usecase/ stays framework-free, so these are
// distinct Go types from the generated proto ones, converted by
// internal/adapter/grpc (TASK-079).
type Project struct {
	ID     string
	Slug   string
	Title  string
	Number int32
	Owner  string
	URL    string
}

type ProjectView struct {
	ID     string
	Name   string
	Layout string
}

type ProjectItem struct {
	ID          string
	Title       string
	ContentType string
	ContentURL  string
	Fields      []ProjectFieldValue
}

type IssueType struct {
	ID          string
	Name        string
	Description string
}

type AssignableUser struct {
	Login     string
	Name      string
	AvatarURL string
}

type Label struct {
	Name        string
	Color       string
	Description string
}

type ProjectComment struct {
	ID     string
	Body   string
	Author string
	URL    string
}

type WorkItemDetails struct {
	Slug   string
	Title  string
	Body   string
	State  string
	URL    string
	Fields []ProjectFieldValue
}

// WorkItemPatch is the shared partial-update shape for
// UpdateIssueBySlug/UpdatePullRequestBySlug — nil pointer fields mean
// "leave unchanged", same convention as IssuePatch.
type WorkItemPatch struct {
	Title        *string
	Body         *string
	State        *string
	AddLabels    []string
	RemoveLabels []string
}

// GitHubProjectsProvider is a SEPARATE, narrower port than ScmProvider —
// only internal/adapter/github implements it (TASK-079). Projects v2 isn't
// part of the common ScmProvider surface at all, since no other provider
// has it (see scm-integration-service.md §4's "each provider implements a
// common port" principle).
type GitHubProjectsProvider interface {
	ListAccessibleProjects(ctx context.Context, cred Credential) ([]Project, error)
	ResolveProjectRef(ctx context.Context, cred Credential, owner string, number int32) (Project, error)
	ListProjectViews(ctx context.Context, cred Credential, projectSlug string) ([]ProjectView, error)
	ViewProjectTable(ctx context.Context, cred Credential, projectSlug, viewID, pageToken string, pageSize int32) (items []ProjectItem, nextPageToken string, err error)
	UpdateProjectItemField(ctx context.Context, cred Credential, projectSlug, itemID string, field ProjectFieldValue) (ProjectItem, error)
	ClearProjectItemField(ctx context.Context, cred Credential, projectSlug, itemID, fieldID string) (ProjectItem, error)
	GetWorkItemDetailsBySlug(ctx context.Context, cred Credential, itemSlug string) (WorkItemDetails, error)
	UpdateIssueBySlug(ctx context.Context, cred Credential, itemSlug string, patch WorkItemPatch) (WorkItemDetails, error)
	UpdatePullRequestBySlug(ctx context.Context, cred Credential, itemSlug string, patch WorkItemPatch) (WorkItemDetails, error)
	UpdateIssueTypeBySlug(ctx context.Context, cred Credential, itemSlug, issueType string) (WorkItemDetails, error)
	ListIssueTypesBySlug(ctx context.Context, cred Credential, itemSlug string) ([]IssueType, error)
	ListAssignableUsersBySlug(ctx context.Context, cred Credential, itemSlug string) ([]AssignableUser, error)
	ListLabelsBySlug(ctx context.Context, cred Credential, itemSlug string) ([]Label, error)
	AddIssueCommentBySlug(ctx context.Context, cred Credential, itemSlug, body string) (ProjectComment, error)
	UpdateIssueCommentBySlug(ctx context.Context, cred Credential, itemSlug, commentID, body string) (ProjectComment, error)
	DeleteIssueCommentBySlug(ctx context.Context, cred Credential, itemSlug, commentID string) error
}

// MRFilter narrows a ListMergeRequests call — mirrors IssueFilter's shape.
type MRFilter struct {
	State        string
	SourceBranch string
}

// GitLabMergeRequestProvider is a GitLab-only port, same reasoning as
// GitHubProjectsProvider (see its doc comment): these 3 operations don't
// belong on the common ScmProvider interface since no other provider
// implements them.
type GitLabMergeRequestProvider interface {
	ListMergeRequests(ctx context.Context, cred Credential, repo string, filter MRFilter) ([]domain.MergeRequest, error)
	ResolveDiscussion(ctx context.Context, cred Credential, repo string, mrIID int32, discussionID string, resolved bool) (domain.MergeRequestDiscussion, error)
	GetWorkItemDetails(ctx context.Context, cred Credential, repo string, iid int32, itemType string) (domain.WorkItemDetailsGitLab, error)
}
