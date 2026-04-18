import { execFile } from 'child_process';
import { gitExecFileAsync, ghExecFileAsync } from '../git/runner';
export declare const execFileAsync: typeof execFile.__promisify__;
export { ghExecFileAsync, gitExecFileAsync };
export declare function acquire(): Promise<void>;
export declare function release(): void;
/** @internal — exposed for tests only */
export declare function _resetOwnerRepoCache(): void;
export declare function getOwnerRepo(repoPath: string): Promise<{
    owner: string;
    repo: string;
} | null>;
