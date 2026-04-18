import type { RelayDispatcher } from './dispatcher';
import type { RelayContext } from './context';
export declare class GitHandler {
    private dispatcher;
    private context;
    constructor(dispatcher: RelayDispatcher, context: RelayContext);
    private registerHandlers;
    private git;
    private gitBuffer;
    private getStatus;
    private detectConflictOperation;
    private resolveGitDir;
    private getDiff;
    private stage;
    private unstage;
    private bulkStage;
    private bulkUnstage;
    private discard;
    private conflictOperation;
    private branchCompare;
    private branchDiff;
    private exec;
    private isGitRepo;
    private listWorktrees;
    private addWorktree;
    private removeWorktree;
}
