package usecase

import (
	"context"
	"errors"
	"testing"

	"github.com/stablyai/orca-go/services/git-gateway-service/internal/domain"
)

// fakeFilesystemExecutor is an in-memory FilesystemExecutor +
// LocalOnlyFilesystemExecutor — records which method was called so tests
// can assert dispatch routing, mirroring fakeGitExecutor's pattern above.
type fakeFilesystemExecutor struct {
	calledReadFile       bool
	calledReadDir        bool
	calledWriteFile      bool
	calledWriteFileChunk bool
	calledCreateDir      bool
	calledCreateFile     bool
	calledDelete         bool
	calledStat           bool
	calledRename         bool
	calledCopy           bool
	calledSearch         bool
	calledGlob           bool
	gotRepoPath          string
	readFileContent      []byte
	readFileErr          error
}

func (f *fakeFilesystemExecutor) ReadFile(ctx context.Context, repoPath, relPath string) ([]byte, error) {
	f.calledReadFile = true
	f.gotRepoPath = repoPath
	if f.readFileErr != nil {
		return nil, f.readFileErr
	}
	if f.readFileContent != nil {
		return f.readFileContent, nil
	}
	return []byte("content"), nil
}

func (f *fakeFilesystemExecutor) ReadFilePreview(ctx context.Context, repoPath, relPath string, maxBytes int64) ([]byte, bool, error) {
	return []byte("preview"), false, nil
}

func (f *fakeFilesystemExecutor) ReadDir(ctx context.Context, repoPath, relPath string) ([]domain.DirEntry, error) {
	f.calledReadDir = true
	f.gotRepoPath = repoPath
	return []domain.DirEntry{{Name: "a.txt"}}, nil
}

func (f *fakeFilesystemExecutor) WriteFile(ctx context.Context, repoPath, relPath string, content []byte, createParents bool) (int64, error) {
	f.calledWriteFile = true
	f.gotRepoPath = repoPath
	return int64(len(content)), nil
}

func (f *fakeFilesystemExecutor) WriteFileChunk(ctx context.Context, repoPath, relPath string, offsetBytes int64, content []byte, isFinal bool) (int64, error) {
	f.calledWriteFileChunk = true
	f.gotRepoPath = repoPath
	return int64(len(content)), nil
}

func (f *fakeFilesystemExecutor) CreateDir(ctx context.Context, repoPath, relPath string, recursive, noClobber bool) error {
	f.calledCreateDir = true
	f.gotRepoPath = repoPath
	return nil
}

func (f *fakeFilesystemExecutor) CreateFile(ctx context.Context, repoPath, relPath string) error {
	f.calledCreateFile = true
	f.gotRepoPath = repoPath
	return nil
}

func (f *fakeFilesystemExecutor) Delete(ctx context.Context, repoPath, relPath string, recursive bool) error {
	f.calledDelete = true
	f.gotRepoPath = repoPath
	return nil
}

func (f *fakeFilesystemExecutor) Stat(ctx context.Context, repoPath, relPath string) (domain.FileStat, error) {
	f.calledStat = true
	f.gotRepoPath = repoPath
	return domain.FileStat{Exists: true}, nil
}

func (f *fakeFilesystemExecutor) Search(ctx context.Context, repoPath string, opts domain.SearchOptions) ([]domain.SearchMatch, error) {
	f.calledSearch = true
	return []domain.SearchMatch{{Path: "a.txt", Line: 1}}, nil
}

func (f *fakeFilesystemExecutor) Glob(ctx context.Context, repoPath, pattern string, maxResults int) ([]string, error) {
	f.calledGlob = true
	f.gotRepoPath = repoPath
	return []string{"a.txt", "b.md"}, nil
}

func (f *fakeFilesystemExecutor) Rename(ctx context.Context, repoPath, fromRel, toRel string) error {
	f.calledRename = true
	return nil
}

func (f *fakeFilesystemExecutor) Copy(ctx context.Context, repoPath, fromRel, toRel string) error {
	f.calledCopy = true
	return nil
}

func TestReadFileUseCase_RoutesByConnectionState(t *testing.T) {
	local := &fakeFilesystemExecutor{}
	relay := &fakeFilesystemExecutor{}
	uc := NewReadFileUseCase(&fakeConnectionResolver{conn: ResolvedConnection{Connected: true, RepoPath: "/repo"}}, local, relay)

	got, err := uc.Execute(context.Background(), "wt1", "a.txt")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !relay.calledReadFile || local.calledReadFile {
		t.Error("expected ReadFile to route to relay when Connected=true")
	}
	if string(got) != "content" {
		t.Errorf("unexpected content: %q", got)
	}
}

func TestReadFileChunkUseCase_Connected_ReturnsNotSupported(t *testing.T) {
	local := &fakeFilesystemExecutor{}
	uc := NewReadFileChunkUseCase(&fakeConnectionResolver{conn: ResolvedConnection{Connected: true}}, local)

	_, err := uc.Execute(context.Background(), "wt1", "a.txt", 0, 10)
	if !errors.Is(err, ErrChunkedReadNotSupportedRemote) {
		t.Fatalf("expected ErrChunkedReadNotSupportedRemote, got %v", err)
	}
	if local.calledReadFile {
		t.Error("expected local executor NOT to be called for a relay-connected worktree")
	}
}

func TestReadFileChunkUseCase_NotConnected_SlicesContent(t *testing.T) {
	local := &fakeFilesystemExecutor{readFileContent: []byte("0123456789")}
	uc := NewReadFileChunkUseCase(&fakeConnectionResolver{conn: ResolvedConnection{Connected: false}}, local)

	got, err := uc.Execute(context.Background(), "wt1", "a.txt", 2, 3)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if string(got) != "234" {
		t.Errorf("expected chunk %q, got %q", "234", got)
	}
}

func TestWriteFileUseCase_RoutesByConnectionState(t *testing.T) {
	local := &fakeFilesystemExecutor{}
	relay := &fakeFilesystemExecutor{}
	uc := NewWriteFileUseCase(&fakeConnectionResolver{conn: ResolvedConnection{Connected: false}}, local, relay)

	n, err := uc.Execute(context.Background(), "wt1", "a.txt", []byte("hello"), false)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !local.calledWriteFile || relay.calledWriteFile {
		t.Error("expected WriteFile to route to local when Connected=false")
	}
	if n != 5 {
		t.Errorf("expected 5 bytes written, got %d", n)
	}
}

func TestSearchFilesUseCase_DelegatesToExecutor(t *testing.T) {
	local := &fakeFilesystemExecutor{}
	uc := NewSearchFilesUseCase(&fakeConnectionResolver{conn: ResolvedConnection{Connected: false}}, local, local)

	_, err := uc.Execute(context.Background(), "wt1", domain.SearchOptions{Pattern: "foo"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !local.calledSearch {
		t.Error("expected Search to be called")
	}
}

func TestListMarkdownDocumentsUseCase_FiltersToMarkdown(t *testing.T) {
	local := &fakeFilesystemExecutor{} // Glob returns {"a.txt", "b.md"}
	uc := NewListMarkdownDocumentsUseCase(&fakeConnectionResolver{conn: ResolvedConnection{Connected: false}}, local, local)

	got, err := uc.Execute(context.Background(), "wt1", 0)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(got) != 1 || got[0] != "b.md" {
		t.Errorf("expected only b.md, got %+v", got)
	}
}

func TestRenameFileUseCase_Connected_ReturnsNotSupported(t *testing.T) {
	local := &fakeFilesystemExecutor{}
	uc := NewRenameFileUseCase(&fakeConnectionResolver{conn: ResolvedConnection{Connected: true}}, local)

	err := uc.Execute(context.Background(), "wt1", "a.txt", "b.txt")
	if !errors.Is(err, ErrFileOpNotSupportedOverRelay) {
		t.Fatalf("expected ErrFileOpNotSupportedOverRelay, got %v", err)
	}
	if local.calledRename {
		t.Error("expected local executor NOT to be called for a relay-connected worktree")
	}
}

func TestRenameFileUseCase_NotConnected_CallsLocal(t *testing.T) {
	local := &fakeFilesystemExecutor{}
	uc := NewRenameFileUseCase(&fakeConnectionResolver{conn: ResolvedConnection{Connected: false}}, local)

	if err := uc.Execute(context.Background(), "wt1", "a.txt", "b.txt"); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !local.calledRename {
		t.Error("expected local Rename to be called")
	}
}

func TestCopyFileUseCase_Connected_ReturnsNotSupported(t *testing.T) {
	local := &fakeFilesystemExecutor{}
	uc := NewCopyFileUseCase(&fakeConnectionResolver{conn: ResolvedConnection{Connected: true}}, local)

	err := uc.Execute(context.Background(), "wt1", "a.txt", "b.txt")
	if !errors.Is(err, ErrFileOpNotSupportedOverRelay) {
		t.Fatalf("expected ErrFileOpNotSupportedOverRelay, got %v", err)
	}
}

func TestReadDirUseCase_RoutesByConnectionState(t *testing.T) {
	local := &fakeFilesystemExecutor{}
	relay := &fakeFilesystemExecutor{}
	uc := NewReadDirUseCase(&fakeConnectionResolver{conn: ResolvedConnection{Connected: true, RepoPath: "/repo"}}, local, relay)

	got, err := uc.Execute(context.Background(), "wt1", "subdir")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !relay.calledReadDir || local.calledReadDir {
		t.Error("expected ReadDir to route to relay when Connected=true")
	}
	if relay.gotRepoPath != "/repo" {
		t.Errorf("expected resolved repo path to reach executor, got %q", relay.gotRepoPath)
	}
	if len(got) != 1 || got[0].Name != "a.txt" {
		t.Errorf("unexpected entries: %+v", got)
	}
}

func TestReadDirUseCase_NotConnected_CallsLocal(t *testing.T) {
	local := &fakeFilesystemExecutor{}
	relay := &fakeFilesystemExecutor{}
	uc := NewReadDirUseCase(&fakeConnectionResolver{conn: ResolvedConnection{Connected: false, RepoPath: "/repo"}}, local, relay)

	if _, err := uc.Execute(context.Background(), "wt1", "subdir"); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !local.calledReadDir || relay.calledReadDir {
		t.Error("expected ReadDir to route to local when Connected=false")
	}
}

func TestStatFileUseCase_RoutesByConnectionState(t *testing.T) {
	local := &fakeFilesystemExecutor{}
	relay := &fakeFilesystemExecutor{}
	uc := NewStatFileUseCase(&fakeConnectionResolver{conn: ResolvedConnection{Connected: true, RepoPath: "/repo"}}, local, relay)

	got, err := uc.Execute(context.Background(), "wt1", "a.txt")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !relay.calledStat || local.calledStat {
		t.Error("expected Stat to route to relay when Connected=true")
	}
	if !got.Exists {
		t.Errorf("unexpected stat result: %+v", got)
	}
}

func TestStatFileUseCase_NotConnected_CallsLocal(t *testing.T) {
	local := &fakeFilesystemExecutor{}
	relay := &fakeFilesystemExecutor{}
	uc := NewStatFileUseCase(&fakeConnectionResolver{conn: ResolvedConnection{Connected: false, RepoPath: "/repo"}}, local, relay)

	if _, err := uc.Execute(context.Background(), "wt1", "a.txt"); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !local.calledStat || relay.calledStat {
		t.Error("expected Stat to route to local when Connected=false")
	}
}

func TestCreateDirUseCase_RoutesByConnectionState(t *testing.T) {
	local := &fakeFilesystemExecutor{}
	relay := &fakeFilesystemExecutor{}
	uc := NewCreateDirUseCase(&fakeConnectionResolver{conn: ResolvedConnection{Connected: true, RepoPath: "/repo"}}, local, relay)

	if err := uc.Execute(context.Background(), "wt1", "newdir", true, false); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !relay.calledCreateDir || local.calledCreateDir {
		t.Error("expected CreateDir to route to relay when Connected=true")
	}
}

func TestCreateDirUseCase_NotConnected_CallsLocal(t *testing.T) {
	local := &fakeFilesystemExecutor{}
	relay := &fakeFilesystemExecutor{}
	// noClobber=true exercises the files.createDirNoClobber call site — same
	// usecase, one bool param, per SOL-009's proto-collapse note.
	uc := NewCreateDirUseCase(&fakeConnectionResolver{conn: ResolvedConnection{Connected: false, RepoPath: "/repo"}}, local, relay)

	if err := uc.Execute(context.Background(), "wt1", "newdir", false, true); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !local.calledCreateDir || relay.calledCreateDir {
		t.Error("expected CreateDir to route to local when Connected=false")
	}
}

func TestCreateFileUseCase_RoutesByConnectionState(t *testing.T) {
	local := &fakeFilesystemExecutor{}
	relay := &fakeFilesystemExecutor{}
	uc := NewCreateFileUseCase(&fakeConnectionResolver{conn: ResolvedConnection{Connected: true, RepoPath: "/repo"}}, local, relay)

	if err := uc.Execute(context.Background(), "wt1", "newfile.txt"); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !relay.calledCreateFile || local.calledCreateFile {
		t.Error("expected CreateFile to route to relay when Connected=true")
	}
}

func TestCreateFileUseCase_NotConnected_CallsLocal(t *testing.T) {
	local := &fakeFilesystemExecutor{}
	relay := &fakeFilesystemExecutor{}
	uc := NewCreateFileUseCase(&fakeConnectionResolver{conn: ResolvedConnection{Connected: false, RepoPath: "/repo"}}, local, relay)

	if err := uc.Execute(context.Background(), "wt1", "newfile.txt"); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !local.calledCreateFile || relay.calledCreateFile {
		t.Error("expected CreateFile to route to local when Connected=false")
	}
}

func TestDeleteFileUseCase_RoutesByConnectionState(t *testing.T) {
	local := &fakeFilesystemExecutor{}
	relay := &fakeFilesystemExecutor{}
	uc := NewDeleteFileUseCase(&fakeConnectionResolver{conn: ResolvedConnection{Connected: true, RepoPath: "/repo"}}, local, relay)

	if err := uc.Execute(context.Background(), "wt1", "a.txt", false); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !relay.calledDelete || local.calledDelete {
		t.Error("expected Delete to route to relay when Connected=true")
	}
}

func TestDeleteFileUseCase_NotConnected_CallsLocal(t *testing.T) {
	local := &fakeFilesystemExecutor{}
	relay := &fakeFilesystemExecutor{}
	uc := NewDeleteFileUseCase(&fakeConnectionResolver{conn: ResolvedConnection{Connected: false, RepoPath: "/repo"}}, local, relay)

	if err := uc.Execute(context.Background(), "wt1", "a.txt", true); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !local.calledDelete || relay.calledDelete {
		t.Error("expected Delete to route to local when Connected=false")
	}
}

func TestWriteFileChunkUseCase_RoutesByConnectionState(t *testing.T) {
	local := &fakeFilesystemExecutor{}
	relay := &fakeFilesystemExecutor{}
	uc := NewWriteFileChunkUseCase(&fakeConnectionResolver{conn: ResolvedConnection{Connected: true, RepoPath: "/repo"}}, local, relay)

	n, err := uc.Execute(context.Background(), "wt1", "a.txt", 0, []byte("hello"), true)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !relay.calledWriteFileChunk || local.calledWriteFileChunk {
		t.Error("expected WriteFileChunk to route to relay when Connected=true")
	}
	if n != 5 {
		t.Errorf("expected 5 bytes written, got %d", n)
	}
}

func TestWriteFileChunkUseCase_NotConnected_CallsLocal(t *testing.T) {
	local := &fakeFilesystemExecutor{}
	relay := &fakeFilesystemExecutor{}
	uc := NewWriteFileChunkUseCase(&fakeConnectionResolver{conn: ResolvedConnection{Connected: false, RepoPath: "/repo"}}, local, relay)

	if _, err := uc.Execute(context.Background(), "wt1", "a.txt", 0, []byte("hi"), false); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !local.calledWriteFileChunk || relay.calledWriteFileChunk {
		t.Error("expected WriteFileChunk to route to local when Connected=false")
	}
}

func TestListAllFilesUseCase_RoutesByConnectionState(t *testing.T) {
	local := &fakeFilesystemExecutor{}
	relay := &fakeFilesystemExecutor{}
	uc := NewListAllFilesUseCase(&fakeConnectionResolver{conn: ResolvedConnection{Connected: true, RepoPath: "/repo"}}, local, relay)

	got, err := uc.Execute(context.Background(), "wt1", "*", 10)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !relay.calledGlob || local.calledGlob {
		t.Error("expected ListAllFiles to route to relay (via Glob) when Connected=true")
	}
	if len(got) != 2 {
		t.Errorf("unexpected paths: %+v", got)
	}
}

func TestListAllFilesUseCase_NotConnected_CallsLocal(t *testing.T) {
	local := &fakeFilesystemExecutor{}
	relay := &fakeFilesystemExecutor{}
	uc := NewListAllFilesUseCase(&fakeConnectionResolver{conn: ResolvedConnection{Connected: false, RepoPath: "/repo"}}, local, relay)

	if _, err := uc.Execute(context.Background(), "wt1", "*", 10); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !local.calledGlob || relay.calledGlob {
		t.Error("expected ListAllFiles to route to local (via Glob) when Connected=false")
	}
}
