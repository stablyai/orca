package localfs

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/stablyai/orca-go/services/git-gateway-service/internal/domain"
)

func TestReadWriteFile_RoundTrips(t *testing.T) {
	dir := t.TempDir()
	e := New()
	ctx := context.Background()

	n, err := e.WriteFile(ctx, dir, "a.txt", []byte("hello"), false)
	if err != nil {
		t.Fatalf("WriteFile: %v", err)
	}
	if n != 5 {
		t.Errorf("expected 5 bytes written, got %d", n)
	}

	got, err := e.ReadFile(ctx, dir, "a.txt")
	if err != nil {
		t.Fatalf("ReadFile: %v", err)
	}
	if string(got) != "hello" {
		t.Errorf("expected %q, got %q", "hello", got)
	}
}

func TestWriteFile_CreateParents(t *testing.T) {
	dir := t.TempDir()
	e := New()

	if _, err := e.WriteFile(context.Background(), dir, "sub/dir/a.txt", []byte("x"), true); err != nil {
		t.Fatalf("unexpected error with createParents=true: %v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, "sub/dir/a.txt")); err != nil {
		t.Errorf("expected file to exist: %v", err)
	}
}

func TestResolve_RejectsPathEscape(t *testing.T) {
	dir := t.TempDir()
	e := New()

	_, err := e.ReadFile(context.Background(), dir, "../../etc/passwd")
	if !errors.Is(err, ErrPathEscapesWorktree) {
		t.Fatalf("expected ErrPathEscapesWorktree, got %v", err)
	}
}

func TestStat_NonexistentPath_ReturnsExistsFalse(t *testing.T) {
	dir := t.TempDir()
	e := New()

	got, err := e.Stat(context.Background(), dir, "nope.txt")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got.Exists {
		t.Errorf("expected Exists=false, got %+v", got)
	}
}

func TestStat_ExistingFile_ReportsSize(t *testing.T) {
	dir := t.TempDir()
	e := New()
	if _, err := e.WriteFile(context.Background(), dir, "a.txt", []byte("hello"), false); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}

	got, err := e.Stat(context.Background(), dir, "a.txt")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !got.Exists || got.IsDirectory || got.SizeBytes != 5 {
		t.Errorf("unexpected stat result: %+v", got)
	}
}

func TestRename_MovesFile(t *testing.T) {
	dir := t.TempDir()
	e := New()
	if _, err := e.WriteFile(context.Background(), dir, "a.txt", []byte("x"), false); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}

	if err := e.Rename(context.Background(), dir, "a.txt", "b.txt"); err != nil {
		t.Fatalf("Rename: %v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, "a.txt")); !os.IsNotExist(err) {
		t.Error("expected a.txt to no longer exist")
	}
	if _, err := os.Stat(filepath.Join(dir, "b.txt")); err != nil {
		t.Errorf("expected b.txt to exist: %v", err)
	}
}

func TestCopy_DuplicatesFile(t *testing.T) {
	dir := t.TempDir()
	e := New()
	if _, err := e.WriteFile(context.Background(), dir, "a.txt", []byte("x"), false); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}

	if err := e.Copy(context.Background(), dir, "a.txt", "b.txt"); err != nil {
		t.Fatalf("Copy: %v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, "a.txt")); err != nil {
		t.Errorf("expected a.txt to still exist after copy: %v", err)
	}
	got, err := e.ReadFile(context.Background(), dir, "b.txt")
	if err != nil || string(got) != "x" {
		t.Errorf("expected b.txt to contain %q, got %q (err=%v)", "x", got, err)
	}
}

func TestCreateDir_NoClobber_RejectsExisting(t *testing.T) {
	dir := t.TempDir()
	e := New()
	if err := e.CreateDir(context.Background(), dir, "sub", false, false); err != nil {
		t.Fatalf("first CreateDir: %v", err)
	}

	if err := e.CreateDir(context.Background(), dir, "sub", false, true); err == nil {
		t.Fatal("expected error when noClobber=true and path already exists")
	}
}

func TestCreateFile_CreatesEmptyFile(t *testing.T) {
	dir := t.TempDir()
	e := New()

	if err := e.CreateFile(context.Background(), dir, "a.txt"); err != nil {
		t.Fatalf("CreateFile: %v", err)
	}
	info, err := os.Stat(filepath.Join(dir, "a.txt"))
	if err != nil {
		t.Fatalf("expected file to exist: %v", err)
	}
	if info.Size() != 0 {
		t.Errorf("expected empty file, got size %d", info.Size())
	}
}

func TestCreateFile_CreatesParentDirs(t *testing.T) {
	dir := t.TempDir()
	e := New()

	if err := e.CreateFile(context.Background(), dir, "sub/dir/a.txt"); err != nil {
		t.Fatalf("CreateFile: %v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, "sub/dir/a.txt")); err != nil {
		t.Errorf("expected file to exist: %v", err)
	}
}

func TestCreateFile_RejectsExisting(t *testing.T) {
	dir := t.TempDir()
	e := New()
	if err := e.CreateFile(context.Background(), dir, "a.txt"); err != nil {
		t.Fatalf("first CreateFile: %v", err)
	}

	if err := e.CreateFile(context.Background(), dir, "a.txt"); err == nil {
		t.Fatal("expected error when file already exists")
	}
}

func TestGlob_EmptyPattern_MatchesEverything(t *testing.T) {
	dir := t.TempDir()
	e := New()
	if _, err := e.WriteFile(context.Background(), dir, "a.txt", []byte("x"), false); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}
	if _, err := e.WriteFile(context.Background(), dir, "b.md", []byte("x"), false); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}

	got, err := e.Glob(context.Background(), dir, "", 0)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(got) != 2 {
		t.Errorf("expected 2 entries for empty pattern, got %+v", got)
	}
}

func TestGlob_MaxResults_StopsEarly(t *testing.T) {
	dir := t.TempDir()
	e := New()
	for _, name := range []string{"a.txt", "b.txt", "c.txt"} {
		if _, err := e.WriteFile(context.Background(), dir, name, []byte("x"), false); err != nil {
			t.Fatalf("WriteFile: %v", err)
		}
	}

	got, err := e.Glob(context.Background(), dir, "", 1)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(got) != 1 {
		t.Errorf("expected exactly 1 result with maxResults=1, got %+v", got)
	}
}

func TestSearch_FindsSubstringMatch(t *testing.T) {
	dir := t.TempDir()
	e := New()
	if _, err := e.WriteFile(context.Background(), dir, "a.txt", []byte("hello\nworld needle here\n"), false); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}

	got, err := e.Search(context.Background(), dir, domain.SearchOptions{Pattern: "needle"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(got) != 1 || got[0].Line != 2 {
		t.Errorf("expected 1 match on line 2, got %+v", got)
	}
}

func TestSearch_SkipsGitDir(t *testing.T) {
	dir := t.TempDir()
	e := New()
	if err := os.MkdirAll(filepath.Join(dir, ".git"), 0o755); err != nil {
		t.Fatalf("mkdir .git: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, ".git", "COMMIT_EDITMSG"), []byte("needle"), 0o644); err != nil {
		t.Fatalf("write inside .git: %v", err)
	}

	got, err := e.Search(context.Background(), dir, domain.SearchOptions{Pattern: "needle"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(got) != 0 {
		t.Errorf("expected .git to be skipped, got %+v", got)
	}
}
