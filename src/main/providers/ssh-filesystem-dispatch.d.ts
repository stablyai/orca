import type { IFilesystemProvider } from './types';
export declare function registerSshFilesystemProvider(connectionId: string, provider: IFilesystemProvider): void;
export declare function unregisterSshFilesystemProvider(connectionId: string): void;
export declare function getSshFilesystemProvider(connectionId: string): IFilesystemProvider | undefined;
