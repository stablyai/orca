export declare class PrioritySemaphore {
    private available;
    private waiters;
    constructor(concurrency: number);
    acquire(priority: number): Promise<() => void>;
    private release;
}
