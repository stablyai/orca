package usecase

import (
	"context"
	"errors"
	"testing"

	"github.com/stablyai/orca-go/services/scm-integration-service/internal/domain"
)

func TestStarRepository_Success(t *testing.T) {
	provider := &fakeProvider{starRepositoryResult: true}
	registry := &fakeRegistry{providers: map[domain.ScmProvider]ScmProvider{domain.ScmProviderGitHub: provider}}
	uc := NewStarRepository(&fakeCredentialResolver{token: "tok"}, registry)

	starred, err := uc.Execute(context.Background(), StarRepositoryParams{TenantID: "tenant-1", Provider: domain.ScmProviderGitHub, Repo: "getorca/orca"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !starred {
		t.Error("want starred=true")
	}
	if provider.lastRepo != "getorca/orca" {
		t.Errorf("want repo passed through unmodified, got %q", provider.lastRepo)
	}
	if provider.calls != 1 {
		t.Errorf("want exactly 1 provider call, got %d", provider.calls)
	}
}

func TestStarRepository_UsesCallersOwnCredential(t *testing.T) {
	cred := Credential{Token: "caller-token"}
	provider := &fakeProvider{starRepositoryResult: true}
	registry := &fakeRegistry{providers: map[domain.ScmProvider]ScmProvider{domain.ScmProviderGitHub: provider}}
	uc := NewStarRepository(&fakeCredentialResolver{token: cred.Token}, registry)

	if _, err := uc.Execute(context.Background(), StarRepositoryParams{TenantID: "tenant-1", Provider: domain.ScmProviderGitHub, Repo: "o/r"}); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if provider.lastCred.Token != cred.Token {
		t.Errorf("want the resolved (tenant, provider) credential passed through, got %+v", provider.lastCred)
	}
}

func TestStarRepository_CredentialResolutionFailurePropagates(t *testing.T) {
	registry := &fakeRegistry{providers: map[domain.ScmProvider]ScmProvider{domain.ScmProviderGitHub: &fakeProvider{}}}
	uc := NewStarRepository(&fakeCredentialResolver{err: errors.New("no GitHub connection")}, registry)

	_, err := uc.Execute(context.Background(), StarRepositoryParams{TenantID: "tenant-1", Provider: domain.ScmProviderGitHub, Repo: "o/r"})
	if err == nil {
		t.Fatal("want an error when no OAuth credential is connected — must not silently no-op")
	}
}

func TestStarRepository_RequiresTenantAndRepo(t *testing.T) {
	uc := NewStarRepository(&fakeCredentialResolver{}, &fakeRegistry{providers: map[domain.ScmProvider]ScmProvider{}})
	cases := []StarRepositoryParams{{Repo: "o/r"}, {TenantID: "t1"}}
	for _, in := range cases {
		if _, err := uc.Execute(context.Background(), in); err == nil {
			t.Errorf("expected a validation error for %+v", in)
		}
	}
}
