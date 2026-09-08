package usecase

import "context"

type CreateFileUseCase struct {
	resolver ConnectionResolver
	local    FilesystemExecutor
	relay    FilesystemExecutor
}

func NewCreateFileUseCase(resolver ConnectionResolver, local, relay FilesystemExecutor) *CreateFileUseCase {
	return &CreateFileUseCase{resolver: resolver, local: local, relay: relay}
}

// Execute serves files.createFile. Unlike CreateDirUseCase, there is no
// noClobber parameter -- the frontend call site
// (runtime-file-client.ts:395-414's createRuntimePath) never sends an
// overwrite flag for the file case, so creating an already-existing file
// is always an error, matching desktop's local 'wx'-flag semantics
// (desktop/src/main/ipc/filesystem-mutations.ts).
func (uc *CreateFileUseCase) Execute(ctx context.Context, worktreeID, path string) error {
	exec, conn, err := dispatchFilesystemExecutor(ctx, uc.resolver, uc.local, uc.relay, worktreeID)
	if err != nil {
		return err
	}
	return exec.CreateFile(ctx, conn.RepoPath, path)
}
