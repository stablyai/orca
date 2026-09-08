package usecase

import (
	"context"
	"errors"
	"testing"

	"github.com/stablyai/orca-go/services/scm-integration-service/internal/domain"
)

func TestUpdatePullRequest_Success(t *testing.T) {
	pr := domain.PullRequest{ID: "1", Provider: domain.ScmProviderGitHub, Repo: "o/r", Title: "new title", Number: 5}
	provider := &fakeProvider{updatedPR: pr}
	registry := &fakeRegistry{providers: map[domain.ScmProvider]ScmProvider{domain.ScmProviderGitHub: provider}}
	uc := NewUpdatePullRequest(&fakeCredentialResolver{token: "tok"}, registry)

	title := "new title"
	got, err := uc.Execute(context.Background(), UpdatePullRequestParams{
		TenantID: "tenant-1", Provider: domain.ScmProviderGitHub, Repo: "o/r", Number: 5, Patch: PullRequestPatch{Title: &title},
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got.Title != "new title" || provider.calls != 1 {
		t.Fatalf("unexpected result: %+v calls=%d", got, provider.calls)
	}
}

// fakeProviderCapturingPatch is a small one-off fake local to this test
// file — capturing an argument (not just returning a canned value) doesn't
// fit the shared fakeProvider's existing "set a result field, read it back"
// shape.
type fakeProviderCapturingPatch struct {
	ScmProvider
	captured *PullRequestPatch
}

func (f *fakeProviderCapturingPatch) UpdatePullRequest(ctx context.Context, cred Credential, repo string, number int32, patch PullRequestPatch) (domain.PullRequest, error) {
	*f.captured = patch
	return domain.PullRequest{}, nil
}

func TestUpdatePullRequest_NilTitleMeansUnchanged(t *testing.T) {
	var capturedPatch PullRequestPatch
	provider := &fakeProviderCapturingPatch{captured: &capturedPatch}
	registry := &fakeRegistry{providers: map[domain.ScmProvider]ScmProvider{domain.ScmProviderGitHub: provider}}
	uc := NewUpdatePullRequest(&fakeCredentialResolver{token: "tok"}, registry)

	if _, err := uc.Execute(context.Background(), UpdatePullRequestParams{TenantID: "tenant-1", Provider: domain.ScmProviderGitHub, Repo: "o/r", Number: 1}); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if capturedPatch.Title != nil {
		t.Errorf("want a nil Title passed straight through as 'no title field sent', got %v", capturedPatch.Title)
	}
}

func TestUpdatePullRequest_PropagatesProviderFailure(t *testing.T) {
	provider := &fakeProvider{updatePRErr: errors.New("not found")}
	registry := &fakeRegistry{providers: map[domain.ScmProvider]ScmProvider{domain.ScmProviderGitHub: provider}}
	uc := NewUpdatePullRequest(&fakeCredentialResolver{token: "tok"}, registry)

	_, err := uc.Execute(context.Background(), UpdatePullRequestParams{TenantID: "tenant-1", Provider: domain.ScmProviderGitHub, Repo: "o/r", Number: 1})
	if err == nil {
		t.Fatal("expected an error when the provider call fails")
	}
}

func TestUpdatePullRequest_RequiresTenantAndRepo(t *testing.T) {
	uc := NewUpdatePullRequest(&fakeCredentialResolver{}, &fakeRegistry{providers: map[domain.ScmProvider]ScmProvider{}})
	cases := []UpdatePullRequestParams{{Repo: "o/r"}, {TenantID: "t1"}}
	for _, in := range cases {
		if _, err := uc.Execute(context.Background(), in); err == nil {
			t.Errorf("expected a validation error for %+v", in)
		}
	}
}
