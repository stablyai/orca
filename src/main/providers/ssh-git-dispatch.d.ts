import type { IGitProvider } from './types';
export declare function registerSshGitProvider(connectionId: string, provider: IGitProvider): void;
export declare function unregisterSshGitProvider(connectionId: string): void;
export declare function getSshGitProvider(connectionId: string): IGitProvider | undefined;
