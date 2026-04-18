import type { SshChannelMultiplexer } from '../ssh/ssh-channel-multiplexer';
import type { IFilesystemProvider, FileStat, FileReadResult } from './types';
import type { DirEntry, FsChangeEvent, SearchOptions, SearchResult } from '../../shared/types';
export declare class SshFilesystemProvider implements IFilesystemProvider {
    private connectionId;
    private mux;
    private watchListeners;
    private unsubscribeNotifications;
    constructor(connectionId: string, mux: SshChannelMultiplexer);
    dispose(): void;
    getConnectionId(): string;
    readDir(dirPath: string): Promise<DirEntry[]>;
    readFile(filePath: string): Promise<FileReadResult>;
    writeFile(filePath: string, content: string): Promise<void>;
    stat(filePath: string): Promise<FileStat>;
    deletePath(targetPath: string, recursive?: boolean): Promise<void>;
    createFile(filePath: string): Promise<void>;
    createDir(dirPath: string): Promise<void>;
    rename(oldPath: string, newPath: string): Promise<void>;
    copy(source: string, destination: string): Promise<void>;
    realpath(filePath: string): Promise<string>;
    search(opts: SearchOptions): Promise<SearchResult>;
    listFiles(rootPath: string): Promise<string[]>;
    watch(rootPath: string, callback: (events: FsChangeEvent[]) => void): Promise<() => void>;
}
