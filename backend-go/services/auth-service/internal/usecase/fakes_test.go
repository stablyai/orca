package usecase

import (
	"context"
	"errors"
	"fmt"
	"time"

	jose "github.com/go-jose/go-jose/v4"

	"github.com/stablyai/orca-go/common/jwtauth"
	"github.com/stablyai/orca-go/services/auth-service/internal/domain"
)

// fakeUserRepository is an in-memory UserRepository — the "test against
// fakes, not a real database" pattern from
// specs/backend-go/standards/testing-strategy.md's unit-test section.
type fakeUserRepository struct {
	byID    map[string]domain.User
	byEmail map[string]domain.User
	hashes  map[string]string // keyed by user ID

	createErr error
}

func newFakeUserRepository() *fakeUserRepository {
	return &fakeUserRepository{
		byID:    make(map[string]domain.User),
		byEmail: make(map[string]domain.User),
		hashes:  make(map[string]string),
	}
}

func (f *fakeUserRepository) seed(u domain.User, passwordHash string) {
	f.byID[u.ID] = u
	f.byEmail[u.Email] = u
	f.hashes[u.ID] = passwordHash
}

func (f *fakeUserRepository) HasAnyUsers(ctx context.Context) (bool, error) {
	return len(f.byID) > 0, nil
}

func (f *fakeUserRepository) CreateUser(ctx context.Context, user domain.User, passwordHash string) (domain.User, error) {
	if f.createErr != nil {
		return domain.User{}, f.createErr
	}
	if _, exists := f.byEmail[user.Email]; exists {
		return domain.User{}, ErrUserAlreadyExists
	}
	f.seed(user, passwordHash)
	return user, nil
}

func (f *fakeUserRepository) GetUserByEmail(ctx context.Context, email string) (domain.User, string, error) {
	u, ok := f.byEmail[email]
	if !ok {
		return domain.User{}, "", ErrUserNotFound
	}
	return u, f.hashes[u.ID], nil
}

func (f *fakeUserRepository) GetUserByID(ctx context.Context, userID string) (domain.User, error) {
	u, ok := f.byID[userID]
	if !ok {
		return domain.User{}, ErrUserNotFound
	}
	return u, nil
}

func (f *fakeUserRepository) ListUsers(ctx context.Context, tenantID, pageToken string, pageSize int32) ([]domain.User, string, error) {
	var out []domain.User
	for _, u := range f.byID {
		if u.TenantID == tenantID {
			out = append(out, u)
		}
	}
	return out, "", nil
}

func (f *fakeUserRepository) UpdateUserRole(ctx context.Context, userID string, role domain.Role) (domain.User, error) {
	u, ok := f.byID[userID]
	if !ok {
		return domain.User{}, ErrUserNotFound
	}
	u.Role = role
	f.byID[userID] = u
	f.byEmail[u.Email] = u
	return u, nil
}

func (f *fakeUserRepository) SetActive(ctx context.Context, userID string, active bool) error {
	u, ok := f.byID[userID]
	if !ok {
		// Matches the real postgres adapter: affecting 0 rows is not an
		// error — the caller re-reads the user afterward and surfaces
		// ErrUserNotFound from that read instead.
		return nil
	}
	u.IsActive = active
	f.byID[userID] = u
	f.byEmail[u.Email] = u
	return nil
}

func (f *fakeUserRepository) Count(ctx context.Context) (int32, error) {
	return int32(len(f.byID)), nil
}

func (f *fakeUserRepository) SetSsoProvider(ctx context.Context, userID string, provider domain.SsoProvider) error {
	u, ok := f.byID[userID]
	if !ok {
		return nil
	}
	u.SsoProvider = provider
	f.byID[userID] = u
	f.byEmail[u.Email] = u
	return nil
}

// fakeSessionRepository is an in-memory SessionRepository.
type fakeSessionRepository struct {
	byHash map[string]domain.Session
}

func newFakeSessionRepository() *fakeSessionRepository {
	return &fakeSessionRepository{byHash: make(map[string]domain.Session)}
}

func (f *fakeSessionRepository) CreateSession(ctx context.Context, session domain.Session) error {
	f.byHash[session.TokenHash] = session
	return nil
}

func (f *fakeSessionRepository) GetSessionByTokenHash(ctx context.Context, tokenHash string) (domain.Session, error) {
	s, ok := f.byHash[tokenHash]
	if !ok {
		return domain.Session{}, ErrSessionNotFound
	}
	return s, nil
}

func (f *fakeSessionRepository) RevokeSession(ctx context.Context, tokenHash string, revokedAt time.Time) error {
	s, ok := f.byHash[tokenHash]
	if !ok {
		return ErrSessionNotFound
	}
	s.RevokedAt = &revokedAt
	f.byHash[tokenHash] = s
	return nil
}

func (f *fakeSessionRepository) ListForUser(ctx context.Context, userID string) ([]domain.Session, error) {
	var out []domain.Session
	for _, s := range f.byHash {
		if s.UserID == userID {
			out = append(out, s)
		}
	}
	return out, nil
}

func (f *fakeSessionRepository) RevokeAllForUser(ctx context.Context, userID string, revokedAt time.Time) (int32, error) {
	var n int32
	for hash, s := range f.byHash {
		if s.UserID == userID && s.RevokedAt == nil {
			s.RevokedAt = &revokedAt
			f.byHash[hash] = s
			n++
		}
	}
	return n, nil
}

func (f *fakeSessionRepository) CountActive(ctx context.Context, now time.Time) (int32, error) {
	var n int32
	for _, s := range f.byHash {
		if s.IsValid(now) {
			n++
		}
	}
	return n, nil
}

func (f *fakeSessionRepository) GetSessionByRefreshTokenHash(ctx context.Context, refreshTokenHash string) (domain.Session, error) {
	for _, s := range f.byHash {
		if s.RefreshTokenHash != "" && s.RefreshTokenHash == refreshTokenHash {
			return s, nil
		}
	}
	return domain.Session{}, ErrSessionNotFound
}

// fakeSsoGroupRoleMappingRepository is an in-memory
// SsoGroupRoleMappingRepository, keyed the same way the real table's
// UNIQUE(tenant_id, provider, group_name) constraint is keyed.
type fakeSsoGroupRoleMappingRepository struct {
	byKey map[string]domain.SsoGroupRoleMapping
	// listErr, when set, makes ListForProvider return it — TASK-BE-010's
	// fail-closed-to-domain.RoleUser regression test.
	listErr error
}

func newFakeSsoGroupRoleMappingRepository() *fakeSsoGroupRoleMappingRepository {
	return &fakeSsoGroupRoleMappingRepository{byKey: make(map[string]domain.SsoGroupRoleMapping)}
}

func ssoGroupRoleMappingKey(tenantID string, provider domain.SsoProvider, groupName string) string {
	return tenantID + "|" + string(provider) + "|" + groupName
}

func (f *fakeSsoGroupRoleMappingRepository) Upsert(ctx context.Context, m domain.SsoGroupRoleMapping) (domain.SsoGroupRoleMapping, error) {
	key := ssoGroupRoleMappingKey(m.TenantID, m.Provider, m.GroupName)
	if existing, ok := f.byKey[key]; ok {
		existing.Role = m.Role
		f.byKey[key] = existing
		return existing, nil
	}
	f.byKey[key] = m
	return m, nil
}

func (f *fakeSsoGroupRoleMappingRepository) ListForProvider(ctx context.Context, tenantID string, provider domain.SsoProvider) ([]domain.SsoGroupRoleMapping, error) {
	if f.listErr != nil {
		return nil, f.listErr
	}
	var out []domain.SsoGroupRoleMapping
	for _, m := range f.byKey {
		if m.TenantID != tenantID {
			continue
		}
		if provider != "" && m.Provider != provider {
			continue
		}
		out = append(out, m)
	}
	return out, nil
}

// fakeAccessPolicyRepository is an in-memory AccessPolicyRepository —
// stores every version row (append-only, matching the real postgres
// adapter's (id, version) primary key), keyed by id then version.
type fakeAccessPolicyRepository struct {
	versions map[string]map[int32]domain.AccessPolicy

	insertErr error
}

func newFakeAccessPolicyRepository() *fakeAccessPolicyRepository {
	return &fakeAccessPolicyRepository{versions: make(map[string]map[int32]domain.AccessPolicy)}
}

func (f *fakeAccessPolicyRepository) InsertPolicyVersion(ctx context.Context, p domain.AccessPolicy) error {
	if f.insertErr != nil {
		return f.insertErr
	}
	if f.versions[p.ID] == nil {
		f.versions[p.ID] = make(map[int32]domain.AccessPolicy)
	}
	f.versions[p.ID][p.Version] = p
	return nil
}

func (f *fakeAccessPolicyRepository) GetLatestPolicy(ctx context.Context, id string) (domain.AccessPolicy, error) {
	versions, ok := f.versions[id]
	if !ok || len(versions) == 0 {
		return domain.AccessPolicy{}, ErrPolicyNotFound
	}
	var latest domain.AccessPolicy
	for _, p := range versions {
		if p.Version > latest.Version {
			latest = p
		}
	}
	return latest, nil
}

func (f *fakeAccessPolicyRepository) ListLatestPolicies(ctx context.Context, pageToken string, pageSize int32) ([]domain.AccessPolicy, string, error) {
	var out []domain.AccessPolicy
	for id := range f.versions {
		latest, err := f.GetLatestPolicy(ctx, id)
		if err == nil {
			out = append(out, latest)
		}
	}
	return out, "", nil
}

func (f *fakeAccessPolicyRepository) DeletePolicy(ctx context.Context, id string) error {
	delete(f.versions, id)
	return nil
}

func (f *fakeAccessPolicyRepository) CountDistinctIDs(ctx context.Context) (int32, error) {
	return int32(len(f.versions)), nil
}

// fakePolicyPublisher is an in-memory PolicyDataPublisher — records every
// call so tests can assert UpdateAccessPolicy actually invoked it.
type fakePolicyPublisher struct {
	published  []domain.AccessPolicy
	publishErr error
}

func (f *fakePolicyPublisher) PublishPolicyChange(ctx context.Context, policy domain.AccessPolicy) error {
	if f.publishErr != nil {
		return f.publishErr
	}
	f.published = append(f.published, policy)
	return nil
}

// fakeAuditRepository is an in-memory AuditRepository.
type fakeAuditRepository struct {
	entries []domain.AuditEntry
}

func (f *fakeAuditRepository) Append(ctx context.Context, entry domain.AuditEntry) error {
	f.entries = append(f.entries, entry)
	return nil
}

func (f *fakeAuditRepository) Query(ctx context.Context, tenantID string, since time.Time, actorID, action string, outcome domain.Outcome, pageToken string, pageSize int32) ([]domain.AuditEntry, string, error) {
	var out []domain.AuditEntry
	for _, e := range f.entries {
		if e.TenantID != tenantID {
			continue
		}
		if actorID != "" && e.ActorID != actorID {
			continue
		}
		if action != "" && e.Action != action {
			continue
		}
		if outcome != "" && e.Outcome != outcome {
			continue
		}
		out = append(out, e)
	}
	return out, "", nil
}

// fakeHasher is a PasswordHasher that just prefixes with "hashed:" —
// deterministic and fast for unit tests, no real bcrypt cost.
type fakeHasher struct{}

func (fakeHasher) Hash(password string) (string, error) {
	return "hashed:" + password, nil
}

func (fakeHasher) Compare(hash, password string) error {
	if hash != "hashed:"+password {
		return errors.New("fakeHasher: mismatch")
	}
	return nil
}

// fakeClock is a Clock returning a fixed instant, advanceable by tests.
type fakeClock struct {
	now time.Time
}

func (f *fakeClock) Now() time.Time { return f.now }

// fakeTokenSigner is an in-memory TokenSigner — records the last Sign call
// so tests can assert on the claims IssueServiceToken built, without a real
// Vault Transit round trip.
type fakeTokenSigner struct {
	signErr  error
	jwksErr  error
	lastCall jwtauth.Claims
	token    string
	jwks     jose.JSONWebKeySet
}

func (f *fakeTokenSigner) Sign(ctx context.Context, claims jwtauth.Claims) (string, error) {
	if f.signErr != nil {
		return "", f.signErr
	}
	f.lastCall = claims
	if f.token != "" {
		return f.token, nil
	}
	return "fake-signed-token", nil
}

func (f *fakeTokenSigner) PublicJWKS(ctx context.Context) (jose.JSONWebKeySet, error) {
	if f.jwksErr != nil {
		return jose.JSONWebKeySet{}, f.jwksErr
	}
	return f.jwks, nil
}

// fakeSsoIdentityRepository is an in-memory SsoIdentityRepository, keyed by
// "provider|external_subject" the same way auth.sso_identities' UNIQUE
// constraint is keyed.
type fakeSsoIdentityRepository struct {
	byKey map[string]domain.SsoIdentity

	findCalls int
	linkCalls int
}

func newFakeSsoIdentityRepository() *fakeSsoIdentityRepository {
	return &fakeSsoIdentityRepository{byKey: make(map[string]domain.SsoIdentity)}
}

func ssoIdentityKey(provider domain.SsoProvider, subject string) string {
	return string(provider) + "|" + subject
}

func (f *fakeSsoIdentityRepository) seed(identity domain.SsoIdentity) {
	f.byKey[ssoIdentityKey(identity.Provider, identity.ExternalSubject)] = identity
}

func (f *fakeSsoIdentityRepository) FindByProviderSubject(ctx context.Context, provider domain.SsoProvider, externalSubject string) (domain.SsoIdentity, error) {
	f.findCalls++
	id, ok := f.byKey[ssoIdentityKey(provider, externalSubject)]
	if !ok {
		return domain.SsoIdentity{}, ErrSsoIdentityNotFound
	}
	return id, nil
}

func (f *fakeSsoIdentityRepository) Link(ctx context.Context, identity domain.SsoIdentity) error {
	f.linkCalls++
	f.seed(identity)
	return nil
}

func (f *fakeSsoIdentityRepository) TouchLastLogin(ctx context.Context, id string, at time.Time) error {
	for k, v := range f.byKey {
		if v.ID == id {
			v.LastLoginAt = &at
			f.byKey[k] = v
		}
	}
	return nil
}

// fakeTenantResolver is an in-memory TenantResolver.
type fakeTenantResolver struct {
	tenantID string
	err      error
}

func (f *fakeTenantResolver) ResolveTenantForEmail(ctx context.Context, email string) (string, error) {
	if f.err != nil {
		return "", f.err
	}
	return f.tenantID, nil
}

// fakeOPAClient backs requireAdminActor's tests without loading the real
// Rego bundle — allow/decisionErr let a test force either branch of
// Execute's fail-closed check; lastActor records the actor Decision was
// last called with, so a test can assert the OPA input requireAdminActor
// built. Mirrors task-service's own fakeOPAClient shape.
type fakeOPAClient struct {
	allow       bool
	decisionErr error
	lastActor   domain.User
	called      bool
}

func (f *fakeOPAClient) Decision(ctx context.Context, actor domain.User) (bool, error) {
	f.called = true
	f.lastActor = actor
	if f.decisionErr != nil {
		return false, f.decisionErr
	}
	return f.allow, nil
}

// fakeServiceTokenRepository is an in-memory ServiceTokenRepository —
// mirrors fakeUserRepository's "test against fakes" pattern.
type fakeServiceTokenRepository struct {
	byJTI map[string]domain.IssuedServiceToken

	recordErr    error
	isRevokedErr error
	revokeErr    error
}

func newFakeServiceTokenRepository() *fakeServiceTokenRepository {
	return &fakeServiceTokenRepository{byJTI: make(map[string]domain.IssuedServiceToken)}
}

func (f *fakeServiceTokenRepository) RecordIssuedToken(ctx context.Context, token domain.IssuedServiceToken) error {
	if f.recordErr != nil {
		return f.recordErr
	}
	f.byJTI[token.JTI] = token
	return nil
}

func (f *fakeServiceTokenRepository) IsRevoked(ctx context.Context, jti string) (bool, error) {
	if f.isRevokedErr != nil {
		return false, f.isRevokedErr
	}
	t, ok := f.byJTI[jti]
	if !ok {
		return false, nil
	}
	return t.IsRevoked(), nil
}

func (f *fakeServiceTokenRepository) Revoke(ctx context.Context, jti string, revokedAt time.Time) error {
	if f.revokeErr != nil {
		return f.revokeErr
	}
	t, ok := f.byJTI[jti]
	if !ok {
		return fmt.Errorf("fake: revoke issued service token: %w", ErrServiceTokenNotFound)
	}
	t.RevokedAt = &revokedAt
	f.byJTI[jti] = t
	return nil
}

func (f *fakeServiceTokenRepository) ListServiceTokensForUser(ctx context.Context, userID string) ([]domain.IssuedServiceToken, error) {
	var out []domain.IssuedServiceToken
	for _, t := range f.byJTI {
		if t.UserID == userID {
			out = append(out, t)
		}
	}
	return out, nil
}
