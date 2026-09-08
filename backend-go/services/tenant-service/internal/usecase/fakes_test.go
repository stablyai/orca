package usecase

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/stablyai/orca-go/common/apperrors"
	"github.com/stablyai/orca-go/common/tenant"
	"github.com/stablyai/orca-go/services/tenant-service/internal/domain"
)

// The fakes in this file back every *_test.go in this package — the
// "test against fakes, not a real database" pattern from
// specs/backend-go/standards/testing-strategy.md's unit-test section,
// mirroring usage-service's internal/usecase/record_usage_session_test.go.

func withTenant(ctx context.Context, companyID string) context.Context {
	return tenant.WithTenantID(ctx, companyID)
}

// assertAppError asserts err is an *apperrors.AppError with the given Kind —
// mirrors project-service/internal/usecase/fakes_test.go's helper of the
// same name.
func assertAppError(t *testing.T, err error, kind apperrors.Kind) {
	t.Helper()
	if err == nil {
		t.Fatal("expected an error")
	}
	var ae *apperrors.AppError
	if !errors.As(err, &ae) {
		t.Fatalf("expected an *apperrors.AppError, got %T: %v", err, err)
	}
	if ae.Kind != kind {
		t.Errorf("expected Kind=%v, got %v", kind, ae.Kind)
	}
}

type fakeCompanyRepository struct {
	byID      map[string]domain.Company
	createErr error
	getErr    error
	existsErr error
	updateErr error
	listErr   error
}

func newFakeCompanyRepository() *fakeCompanyRepository {
	return &fakeCompanyRepository{byID: map[string]domain.Company{}}
}

func (f *fakeCompanyRepository) Create(ctx context.Context, c domain.Company) (domain.Company, error) {
	if f.createErr != nil {
		return domain.Company{}, f.createErr
	}
	f.byID[c.ID] = c
	return c, nil
}

func (f *fakeCompanyRepository) Get(ctx context.Context, id string) (domain.Company, bool, error) {
	if f.getErr != nil {
		return domain.Company{}, false, f.getErr
	}
	c, ok := f.byID[id]
	return c, ok, nil
}

func (f *fakeCompanyRepository) List(ctx context.Context) ([]domain.Company, error) {
	if f.listErr != nil {
		return nil, f.listErr
	}
	companies := make([]domain.Company, 0, len(f.byID))
	for _, c := range f.byID {
		companies = append(companies, c)
	}
	return companies, nil
}

func (f *fakeCompanyRepository) Exists(ctx context.Context, id string) (bool, error) {
	if f.existsErr != nil {
		return false, f.existsErr
	}
	_, ok := f.byID[id]
	return ok, nil
}

func (f *fakeCompanyRepository) Update(ctx context.Context, id string, patch domain.CompanySettingsPatch) (domain.Company, bool, error) {
	if f.updateErr != nil {
		return domain.Company{}, false, f.updateErr
	}
	c, ok := f.byID[id]
	if !ok {
		return domain.Company{}, false, nil
	}
	if patch.Name != "" {
		c.Name = patch.Name
	}
	if patch.SettingsJSON != "" {
		var settings domain.Settings
		if err := json.Unmarshal([]byte(patch.SettingsJSON), &settings); err != nil {
			return domain.Company{}, false, err
		}
		c.Settings = settings
	}
	f.byID[id] = c
	return c, true, nil
}

// fakeCompanyEmailDomainRepository is an in-memory CompanyEmailDomainRepository.
type fakeCompanyEmailDomainRepository struct {
	byDomain map[string]string // email_domain -> company_id

	resolveErr error
}

func newFakeCompanyEmailDomainRepository() *fakeCompanyEmailDomainRepository {
	return &fakeCompanyEmailDomainRepository{byDomain: map[string]string{}}
}

func (f *fakeCompanyEmailDomainRepository) Add(ctx context.Context, companyID, emailDomain string) error {
	f.byDomain[emailDomain] = companyID
	return nil
}

func (f *fakeCompanyEmailDomainRepository) Remove(ctx context.Context, emailDomain string) error {
	delete(f.byDomain, emailDomain)
	return nil
}

func (f *fakeCompanyEmailDomainRepository) ListForCompany(ctx context.Context, companyID string) ([]string, error) {
	var out []string
	for d, c := range f.byDomain {
		if c == companyID {
			out = append(out, d)
		}
	}
	return out, nil
}

func (f *fakeCompanyEmailDomainRepository) ResolveCompanyID(ctx context.Context, emailDomain string) (string, bool, error) {
	if f.resolveErr != nil {
		return "", false, f.resolveErr
	}
	companyID, ok := f.byDomain[emailDomain]
	return companyID, ok, nil
}

type departmentKey struct{ companyID, id string }

type fakeDepartmentRepository struct {
	byKey     map[departmentKey]domain.Department
	createErr error
	getErr    error
	listErr   error
	updateErr error
}

func newFakeDepartmentRepository() *fakeDepartmentRepository {
	return &fakeDepartmentRepository{byKey: map[departmentKey]domain.Department{}}
}

func (f *fakeDepartmentRepository) Create(ctx context.Context, d domain.Department) (domain.Department, error) {
	if f.createErr != nil {
		return domain.Department{}, f.createErr
	}
	f.byKey[departmentKey{d.CompanyID, d.ID}] = d
	return d, nil
}

func (f *fakeDepartmentRepository) Get(ctx context.Context, companyID, id string) (domain.Department, bool, error) {
	if f.getErr != nil {
		return domain.Department{}, false, f.getErr
	}
	d, ok := f.byKey[departmentKey{companyID, id}]
	return d, ok, nil
}

func (f *fakeDepartmentRepository) List(ctx context.Context, companyID string) ([]domain.Department, error) {
	if f.listErr != nil {
		return nil, f.listErr
	}
	var out []domain.Department
	for key, d := range f.byKey {
		if key.companyID == companyID {
			out = append(out, d)
		}
	}
	return out, nil
}

func (f *fakeDepartmentRepository) Update(ctx context.Context, companyID, id string, patch domain.DepartmentSettingsPatch) (domain.Department, bool, error) {
	if f.updateErr != nil {
		return domain.Department{}, false, f.updateErr
	}
	key := departmentKey{companyID, id}
	d, ok := f.byKey[key]
	if !ok {
		return domain.Department{}, false, nil
	}
	if patch.Name != "" {
		d.Name = patch.Name
	}
	if patch.SettingsJSON != "" {
		var settings domain.Settings
		if err := json.Unmarshal([]byte(patch.SettingsJSON), &settings); err != nil {
			return domain.Department{}, false, err
		}
		d.Settings = settings
	}
	f.byKey[key] = d
	return d, true, nil
}

type fakeUserProfileRepository struct {
	byUserID              map[string]domain.UserProfile
	onboardingStateByUser map[string]string
	upsertErr             error
	getErr                error
	listByDeptErr         error
	listByCompanyErr      error
	listByDeptCalls       int
	listByCompanyCalls    int
	getOnboardingStateErr error
	setOnboardingStateErr error
}

func newFakeUserProfileRepository() *fakeUserProfileRepository {
	return &fakeUserProfileRepository{
		byUserID:              map[string]domain.UserProfile{},
		onboardingStateByUser: map[string]string{},
	}
}

func (f *fakeUserProfileRepository) Upsert(ctx context.Context, p domain.UserProfile) error {
	if f.upsertErr != nil {
		return f.upsertErr
	}
	f.byUserID[p.UserID] = p
	return nil
}

func (f *fakeUserProfileRepository) Get(ctx context.Context, companyID, userID string) (domain.UserProfile, bool, error) {
	if f.getErr != nil {
		return domain.UserProfile{}, false, f.getErr
	}
	p, ok := f.byUserID[userID]
	if !ok || p.CompanyID != companyID {
		return domain.UserProfile{}, false, nil
	}
	return p, true, nil
}

func (f *fakeUserProfileRepository) ListUserIDsByDepartment(ctx context.Context, companyID, departmentID string) ([]string, error) {
	f.listByDeptCalls++
	if f.listByDeptErr != nil {
		return nil, f.listByDeptErr
	}
	var out []string
	for _, p := range f.byUserID {
		if p.CompanyID == companyID && p.DepartmentID == departmentID {
			out = append(out, p.UserID)
		}
	}
	return out, nil
}

func (f *fakeUserProfileRepository) ListUserIDsByCompany(ctx context.Context, companyID string) ([]string, error) {
	f.listByCompanyCalls++
	if f.listByCompanyErr != nil {
		return nil, f.listByCompanyErr
	}
	var out []string
	for _, p := range f.byUserID {
		if p.CompanyID == companyID {
			out = append(out, p.UserID)
		}
	}
	return out, nil
}

func (f *fakeUserProfileRepository) GetOnboardingState(ctx context.Context, companyID, userID string) (string, bool, error) {
	if f.getOnboardingStateErr != nil {
		return "", false, f.getOnboardingStateErr
	}
	stateJSON, ok := f.onboardingStateByUser[userID]
	if !ok {
		return "", false, nil
	}
	return stateJSON, true, nil
}

func (f *fakeUserProfileRepository) SetOnboardingState(ctx context.Context, companyID, userID, stateJSON string) error {
	if f.setOnboardingStateErr != nil {
		return f.setOnboardingStateErr
	}
	f.onboardingStateByUser[userID] = stateJSON
	return nil
}

type teamKey struct{ companyID, id string }

type fakeTeamRepository struct {
	byKey       map[teamKey]domain.Team
	members     map[string][]domain.TeamMember // teamID -> members
	createErr   error
	getErr      error
	addErr      error
	listErr     error
	layersErr   error
	listByCoErr error
	removeErr   error
}

func newFakeTeamRepository() *fakeTeamRepository {
	return &fakeTeamRepository{
		byKey:   map[teamKey]domain.Team{},
		members: map[string][]domain.TeamMember{},
	}
}

func (f *fakeTeamRepository) Create(ctx context.Context, t domain.Team) (domain.Team, error) {
	if f.createErr != nil {
		return domain.Team{}, f.createErr
	}
	f.byKey[teamKey{t.CompanyID, t.ID}] = t
	return t, nil
}

func (f *fakeTeamRepository) Get(ctx context.Context, companyID, id string) (domain.Team, bool, error) {
	if f.getErr != nil {
		return domain.Team{}, false, f.getErr
	}
	t, ok := f.byKey[teamKey{companyID, id}]
	return t, ok, nil
}

func (f *fakeTeamRepository) ListByCompany(ctx context.Context, companyID string) ([]domain.Team, error) {
	if f.listByCoErr != nil {
		return nil, f.listByCoErr
	}
	var out []domain.Team
	for key, t := range f.byKey {
		if key.companyID == companyID {
			out = append(out, t)
		}
	}
	return out, nil
}

func (f *fakeTeamRepository) AddMember(ctx context.Context, m domain.TeamMember) error {
	if f.addErr != nil {
		return f.addErr
	}
	members := f.members[m.TeamID]
	for i, existing := range members {
		if existing.UserID == m.UserID {
			members[i] = m
			f.members[m.TeamID] = members
			return nil
		}
	}
	f.members[m.TeamID] = append(members, m)
	return nil
}

func (f *fakeTeamRepository) RemoveMember(ctx context.Context, teamID, userID string) (bool, error) {
	if f.removeErr != nil {
		return false, f.removeErr
	}
	members := f.members[teamID]
	for i, m := range members {
		if m.UserID == userID {
			f.members[teamID] = append(members[:i], members[i+1:]...)
			return true, nil
		}
	}
	return false, nil
}

func (f *fakeTeamRepository) ListMembers(ctx context.Context, teamID string) ([]domain.TeamMember, error) {
	if f.listErr != nil {
		return nil, f.listErr
	}
	return f.members[teamID], nil
}

func (f *fakeTeamRepository) ListUserTeamLayers(ctx context.Context, companyID, userID string) ([]domain.TeamSettingsLayer, error) {
	if f.layersErr != nil {
		return nil, f.layersErr
	}
	var layers []domain.TeamSettingsLayer
	for key, team := range f.byKey {
		if key.companyID != companyID {
			continue
		}
		for _, m := range f.members[team.ID] {
			if m.UserID == userID {
				layers = append(layers, domain.TeamSettingsLayer{
					TeamID:   team.ID,
					Priority: m.Priority,
					Settings: team.Settings,
				})
			}
		}
	}
	return layers, nil
}

type fakeProfileCache struct {
	byUserID        map[string]domain.ResolvedProfile
	getCalls        int
	setCalls        int
	invalidateCalls []string // userIDs, in call order
}

func newFakeProfileCache() *fakeProfileCache {
	return &fakeProfileCache{byUserID: map[string]domain.ResolvedProfile{}}
}

func (f *fakeProfileCache) Get(ctx context.Context, userID string) (domain.ResolvedProfile, bool) {
	f.getCalls++
	p, ok := f.byUserID[userID]
	return p, ok
}

func (f *fakeProfileCache) Set(ctx context.Context, userID string, profile domain.ResolvedProfile, ttl time.Duration) {
	f.setCalls++
	f.byUserID[userID] = profile
}

func (f *fakeProfileCache) Invalidate(ctx context.Context, userID string) {
	f.invalidateCalls = append(f.invalidateCalls, userID)
	delete(f.byUserID, userID)
}

type fakeCacheInvalidationPublisher struct {
	calls []string // userIDs, in call order
	err   error
}

func newFakeCacheInvalidationPublisher() *fakeCacheInvalidationPublisher {
	return &fakeCacheInvalidationPublisher{}
}

func (f *fakeCacheInvalidationPublisher) PublishProfileInvalidated(ctx context.Context, tenantID, userID string) error {
	f.calls = append(f.calls, userID)
	return f.err
}

var errFakeRepository = errors.New("fake repository error")

// clientStateKey/fakeClientStateRepository — backs get_client_state_test.go/
// set_client_state_test.go, mirroring fakeUserProfileRepository's shape (an
// in-memory map keyed by (userID, column), configurable errors).
type clientStateKey struct{ userID, column string }

type fakeClientStateRepository struct {
	byKey  map[clientStateKey]string
	getErr error
	setErr error
}

func newFakeClientStateRepository() *fakeClientStateRepository {
	return &fakeClientStateRepository{byKey: map[clientStateKey]string{}}
}

func (f *fakeClientStateRepository) GetClientStateColumn(ctx context.Context, companyID, userID, column string) (string, bool, error) {
	if f.getErr != nil {
		return "", false, f.getErr
	}
	v, ok := f.byKey[clientStateKey{userID, column}]
	return v, ok, nil
}

func (f *fakeClientStateRepository) SetClientStateColumn(ctx context.Context, companyID, userID, column, valueJSON string) error {
	if f.setErr != nil {
		return f.setErr
	}
	f.byKey[clientStateKey{userID, column}] = valueJSON
	return nil
}

// workspaceSessionKey/fakeWorkspaceSessionRepository — backs
// get_workspace_session_test.go/set_workspace_session_test.go/
// patch_workspace_session_test.go, same in-memory-map-with-configurable-
// errors shape as every other fake in this file.
type workspaceSessionKey struct{ userID, hostID string }

type fakeWorkspaceSessionRepository struct {
	byKey    map[workspaceSessionKey]string
	getErr   error
	setErr   error
	patchErr error
}

func newFakeWorkspaceSessionRepository() *fakeWorkspaceSessionRepository {
	return &fakeWorkspaceSessionRepository{byKey: map[workspaceSessionKey]string{}}
}

func (f *fakeWorkspaceSessionRepository) Get(ctx context.Context, companyID, userID, hostID string) (string, bool, error) {
	if f.getErr != nil {
		return "", false, f.getErr
	}
	v, ok := f.byKey[workspaceSessionKey{userID, hostID}]
	return v, ok, nil
}

func (f *fakeWorkspaceSessionRepository) Set(ctx context.Context, companyID, userID, hostID, sessionJSON string) error {
	if f.setErr != nil {
		return f.setErr
	}
	f.byKey[workspaceSessionKey{userID, hostID}] = sessionJSON
	return nil
}

// Patch mirrors the real UserWorkspaceSessionRepository's shallow-merge
// semantics (not just a plain overwrite) so usecase tests can exercise
// PatchWorkspaceSession's "merges into existing" contract without a real
// Postgres.
func (f *fakeWorkspaceSessionRepository) Patch(ctx context.Context, companyID, userID, hostID, patchJSON string) error {
	if f.patchErr != nil {
		return f.patchErr
	}
	key := workspaceSessionKey{userID, hostID}
	base := map[string]json.RawMessage{}
	if current, ok := f.byKey[key]; ok && current != "" {
		if err := json.Unmarshal([]byte(current), &base); err != nil {
			return err
		}
	}
	var patch map[string]json.RawMessage
	if err := json.Unmarshal([]byte(patchJSON), &patch); err != nil {
		return err
	}
	for k, v := range patch {
		base[k] = v
	}
	merged, err := json.Marshal(base)
	if err != nil {
		return err
	}
	f.byKey[key] = string(merged)
	return nil
}

// fakeStarNagStateRepository backs star_nag_actions_test.go — mirrors
// fakeUserProfileRepository's shape (an in-memory map keyed by userID,
// configurable errors).
//
// NOTE (environment note, not part of TASK-BE-STORAGE-001..004's own
// scope): this fake and the two below it were found missing mid-session —
// star_nag_actions_test.go (owned by a different, concurrently-running
// task) already references them, so they are restored here verbatim to
// keep this package's tests compiling.
type fakeStarNagStateRepository struct {
	byUserID       map[string]domain.StarNagState
	getOrCreateErr error
	saveErr        error
	saveCalls      int
}

func newFakeStarNagStateRepository() *fakeStarNagStateRepository {
	return &fakeStarNagStateRepository{byUserID: map[string]domain.StarNagState{}}
}

func (f *fakeStarNagStateRepository) GetOrCreate(ctx context.Context, companyID, userID string) (domain.StarNagState, error) {
	if f.getOrCreateErr != nil {
		return domain.StarNagState{}, f.getOrCreateErr
	}
	if s, ok := f.byUserID[userID]; ok {
		return s, nil
	}
	def := domain.NewDefaultStarNagState(userID, companyID)
	f.byUserID[userID] = def
	return def, nil
}

func (f *fakeStarNagStateRepository) Save(ctx context.Context, s domain.StarNagState) error {
	f.saveCalls++
	if f.saveErr != nil {
		return f.saveErr
	}
	f.byUserID[s.UserID] = s
	return nil
}

// fakeScmStarCheckPort backs star_nag_actions_test.go's GitHub-adjacent
// usecase tests — configurable starred/ok return per method, same shape as
// StubAdapter but test-controllable.
type fakeScmStarCheckPort struct {
	checkStarredResult   bool
	checkStarredOK       bool
	starRepositoryResult bool
	starRepositoryOK     bool
}

func (f *fakeScmStarCheckPort) CheckStarred(ctx context.Context, userID string) (bool, bool) {
	return f.checkStarredResult, f.checkStarredOK
}

func (f *fakeScmStarCheckPort) StarRepository(ctx context.Context, userID string) (bool, bool) {
	return f.starRepositoryResult, f.starRepositoryOK
}

// fakeStarNagVisibilityPublisher backs star_nag_actions_test.go's
// visibility-publish assertions — records every call in order.
type fakeStarNagVisibilityPublisher struct {
	calls []fakeStarNagVisibilityCall
	err   error
}

type fakeStarNagVisibilityCall struct {
	TenantID, UserID, Event, Mode, Surface string
}

func (f *fakeStarNagVisibilityPublisher) PublishStarNagVisibilityChanged(ctx context.Context, tenantID, userID, event, mode, surface string) error {
	f.calls = append(f.calls, fakeStarNagVisibilityCall{TenantID: tenantID, UserID: userID, Event: event, Mode: mode, Surface: surface})
	return f.err
}
