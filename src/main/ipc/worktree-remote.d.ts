import type { BrowserWindow } from 'electron';
import type { Store } from '../persistence';
import type { CreateWorktreeArgs, CreateWorktreeResult, Repo } from '../../shared/types';
export declare function notifyWorktreesChanged(mainWindow: BrowserWindow, repoId: string): void;
export declare function createRemoteWorktree(args: CreateWorktreeArgs, repo: Repo, store: Store, mainWindow: BrowserWindow): Promise<CreateWorktreeResult>;
export declare function createLocalWorktree(args: CreateWorktreeArgs, repo: Repo, store: Store, mainWindow: BrowserWindow): Promise<CreateWorktreeResult>;
