import type { RelayDispatcher } from './dispatcher';
import type { RelayContext } from './context';
export declare class FsHandler {
    private dispatcher;
    private context;
    private watches;
    constructor(dispatcher: RelayDispatcher, context: RelayContext);
    private registerHandlers;
    private readDir;
    private readFile;
    private writeFile;
    private stat;
    private deletePath;
    private createFile;
    private createDir;
    private rename;
    private copy;
    private realpath;
    private search;
    private listFiles;
    private watch;
    private unwatch;
    dispose(): void;
}
