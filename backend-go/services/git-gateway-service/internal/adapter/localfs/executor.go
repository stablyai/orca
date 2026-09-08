// Package localfs implements usecase.FilesystemExecutor (and
// usecase.LocalOnlyFilesystemExecutor) against the host filesystem
// directly — the host-local case, parallel to adapter/localgit. Every
// method resolves relPath against repoPath and rejects any resolved path
// that escapes it, per git-gateway-service.md §3's "never trust a
// client-supplied host path" posture, applied one level deeper since file
// I/O takes an additional relative path the git RPCs don't.
package localfs

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/stablyai/orca-go/services/git-gateway-service/internal/domain"
)

// ErrPathEscapesWorktree is returned when relPath, once cleaned and joined
// to repoPath, resolves outside repoPath.
var ErrPathEscapesWorktree = errors.New("localfs: path escapes worktree root")

type Executor struct{}

func New() *Executor {
	return &Executor{}
}

// resolve joins repoPath+relPath and rejects any result that escapes
// repoPath — called first by every method below.
func resolve(repoPath, relPath string) (string, error) {
	full := filepath.Clean(filepath.Join(repoPath, relPath))
	repoPath = filepath.Clean(repoPath)
	if full != repoPath && !strings.HasPrefix(full, repoPath+string(filepath.Separator)) {
		return "", ErrPathEscapesWorktree
	}
	return full, nil
}

func (e *Executor) ReadFile(ctx context.Context, repoPath, relPath string) ([]byte, error) {
	full, err := resolve(repoPath, relPath)
	if err != nil {
		return nil, err
	}
	return os.ReadFile(full)
}

func (e *Executor) ReadFilePreview(ctx context.Context, repoPath, relPath string, maxBytes int64) ([]byte, bool, error) {
	full, err := resolve(repoPath, relPath)
	if err != nil {
		return nil, false, err
	}
	f, err := os.Open(full)
	if err != nil {
		return nil, false, err
	}
	defer f.Close()
	buf := make([]byte, maxBytes)
	n, err := io.ReadFull(f, buf)
	if err != nil && !errors.Is(err, io.ErrUnexpectedEOF) && !errors.Is(err, io.EOF) {
		return nil, false, err
	}
	// Truncated iff more data remained after maxBytes.
	_, peekErr := f.Read(make([]byte, 1))
	truncated := peekErr == nil
	return buf[:n], truncated, nil
}

func (e *Executor) ReadDir(ctx context.Context, repoPath, relPath string) ([]domain.DirEntry, error) {
	full, err := resolve(repoPath, relPath)
	if err != nil {
		return nil, err
	}
	entries, err := os.ReadDir(full)
	if err != nil {
		return nil, err
	}
	out := make([]domain.DirEntry, 0, len(entries))
	for _, ent := range entries {
		out = append(out, domain.DirEntry{Name: ent.Name(), IsDirectory: ent.IsDir()})
	}
	return out, nil
}

func (e *Executor) WriteFile(ctx context.Context, repoPath, relPath string, content []byte, createParents bool) (int64, error) {
	full, err := resolve(repoPath, relPath)
	if err != nil {
		return 0, err
	}
	if createParents {
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			return 0, err
		}
	}
	if err := os.WriteFile(full, content, 0o644); err != nil {
		return 0, err
	}
	return int64(len(content)), nil
}

func (e *Executor) WriteFileChunk(ctx context.Context, repoPath, relPath string, offsetBytes int64, content []byte, isFinal bool) (int64, error) {
	full, err := resolve(repoPath, relPath)
	if err != nil {
		return 0, err
	}
	if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
		return 0, err
	}
	f, err := os.OpenFile(full, os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		return 0, err
	}
	defer f.Close()
	if _, err := f.WriteAt(content, offsetBytes); err != nil {
		return 0, err
	}
	return int64(len(content)), nil
}

func (e *Executor) CreateDir(ctx context.Context, repoPath, relPath string, recursive, noClobber bool) error {
	full, err := resolve(repoPath, relPath)
	if err != nil {
		return err
	}
	if noClobber {
		if _, statErr := os.Stat(full); statErr == nil {
			return fmt.Errorf("localfs: %s already exists", relPath)
		}
	}
	if recursive {
		return os.MkdirAll(full, 0o755)
	}
	return os.Mkdir(full, 0o755)
}

// CreateFile creates an empty file at relPath, always erroring if it
// already exists (files.createFile has no noClobber-equivalent flag —
// see CreateFileRequest's doc comment in gitgateway.proto). O_EXCL makes
// the existence check atomic, avoiding the TOCTOU race a separate
// os.Stat+os.Create pair would have.
func (e *Executor) CreateFile(ctx context.Context, repoPath, relPath string) error {
	full, err := resolve(repoPath, relPath)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
		return err
	}
	f, err := os.OpenFile(full, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o644)
	if err != nil {
		if errors.Is(err, os.ErrExist) {
			return fmt.Errorf("localfs: %s already exists", relPath)
		}
		return err
	}
	return f.Close()
}

func (e *Executor) Delete(ctx context.Context, repoPath, relPath string, recursive bool) error {
	full, err := resolve(repoPath, relPath)
	if err != nil {
		return err
	}
	if recursive {
		return os.RemoveAll(full)
	}
	return os.Remove(full)
}

func (e *Executor) Stat(ctx context.Context, repoPath, relPath string) (domain.FileStat, error) {
	full, err := resolve(repoPath, relPath)
	if err != nil {
		return domain.FileStat{}, err
	}
	info, err := os.Stat(full)
	if errors.Is(err, os.ErrNotExist) {
		return domain.FileStat{Exists: false}, nil
	}
	if err != nil {
		return domain.FileStat{}, err
	}
	return domain.FileStat{
		Exists:           true,
		IsDirectory:      info.IsDir(),
		SizeBytes:        info.Size(),
		ModifiedAtUnixMs: info.ModTime().UnixMilli(),
	}, nil
}

// Rename and Copy implement usecase.LocalOnlyFilesystemExecutor — see
// ports.go's doc comment on why this is a separate interface.
func (e *Executor) Rename(ctx context.Context, repoPath, fromRel, toRel string) error {
	fromFull, err := resolve(repoPath, fromRel)
	if err != nil {
		return err
	}
	toFull, err := resolve(repoPath, toRel)
	if err != nil {
		return err
	}
	return os.Rename(fromFull, toFull)
}

func (e *Executor) Copy(ctx context.Context, repoPath, fromRel, toRel string) error {
	fromFull, err := resolve(repoPath, fromRel)
	if err != nil {
		return err
	}
	toFull, err := resolve(repoPath, toRel)
	if err != nil {
		return err
	}
	content, err := os.ReadFile(fromFull)
	if err != nil {
		return err
	}
	return os.WriteFile(toFull, content, 0o644)
}

// Search walks repoPath and returns every matching line — opts.Pattern is
// either a plain substring or, when opts.IsRegex, a regexp.
func (e *Executor) Search(ctx context.Context, repoPath string, opts domain.SearchOptions) ([]domain.SearchMatch, error) {
	var matcher func(string) bool
	if opts.IsRegex {
		re, err := regexp.Compile(opts.Pattern)
		if err != nil {
			return nil, fmt.Errorf("localfs: invalid search pattern: %w", err)
		}
		matcher = re.MatchString
	} else {
		matcher = func(line string) bool { return strings.Contains(line, opts.Pattern) }
	}

	var matches []domain.SearchMatch
	err := filepath.WalkDir(repoPath, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			// Never descend into .git — its blob/pack contents are binary
			// noise for a text search and can be enormous.
			if d.Name() == ".git" {
				return filepath.SkipDir
			}
			return nil
		}
		if opts.MaxResults > 0 && len(matches) >= opts.MaxResults {
			return errStopWalk
		}
		rel, relErr := filepath.Rel(repoPath, path)
		if relErr != nil {
			return nil
		}
		if opts.PathGlob != "" {
			if ok, _ := filepath.Match(opts.PathGlob, rel); !ok {
				return nil
			}
		}
		content, readErr := os.ReadFile(path)
		if readErr != nil {
			return nil // unreadable file (binary, permissions) — skip, don't fail the whole search
		}
		for i, line := range strings.Split(string(content), "\n") {
			if matcher(line) {
				matches = append(matches, domain.SearchMatch{Path: rel, Line: i + 1, LineText: line})
				if opts.MaxResults > 0 && len(matches) >= opts.MaxResults {
					break
				}
			}
		}
		return nil
	})
	if err != nil && !errors.Is(err, errStopWalk) {
		return nil, err
	}
	return matches, nil
}

// Glob walks repoPath and returns every worktree-relative path matching
// pattern. An empty pattern matches every file (used by
// ListMarkdownDocumentsUseCase/files.listAll's "no filter" case) —
// filepath.Match's own empty pattern only matches an empty string, so that
// case is special-cased here rather than surprising every caller that
// passes "" to mean "everything".
func (e *Executor) Glob(ctx context.Context, repoPath, pattern string, maxResults int) ([]string, error) {
	var out []string
	err := filepath.WalkDir(repoPath, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			if d.Name() == ".git" {
				return filepath.SkipDir
			}
			return nil
		}
		if maxResults > 0 && len(out) >= maxResults {
			return errStopWalk
		}
		rel, relErr := filepath.Rel(repoPath, path)
		if relErr != nil {
			return nil
		}
		if pattern == "" {
			out = append(out, rel)
			return nil
		}
		if ok, _ := filepath.Match(pattern, rel); ok {
			out = append(out, rel)
		}
		return nil
	})
	if err != nil && !errors.Is(err, errStopWalk) {
		return nil, err
	}
	return out, nil
}

// errStopWalk is filepath.WalkDir's early-exit sentinel — this module
// targets a Go version predating 1.20's filepath.SkipAll, so a plain
// sentinel error checked via errors.Is is used instead.
var errStopWalk = errors.New("localfs: stop walk (max results reached)")
