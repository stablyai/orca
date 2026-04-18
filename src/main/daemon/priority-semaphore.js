export class PrioritySemaphore {
    available;
    waiters = [];
    constructor(concurrency) {
        this.available = concurrency;
    }
    acquire(priority) {
        if (this.available > 0) {
            this.available--;
            let released = false;
            return Promise.resolve(() => {
                if (released) {
                    return;
                }
                released = true;
                this.release();
            });
        }
        return new Promise((resolve) => {
            this.waiters.push({ priority, resolve });
        });
    }
    release() {
        if (this.waiters.length === 0) {
            this.available++;
            return;
        }
        // Find the highest-priority (lowest number) waiter.
        // Among equal priorities, take the first (FIFO).
        let bestIdx = 0;
        for (let i = 1; i < this.waiters.length; i++) {
            if (this.waiters[i].priority < this.waiters[bestIdx].priority) {
                bestIdx = i;
            }
        }
        const waiter = this.waiters.splice(bestIdx, 1)[0];
        let released = false;
        waiter.resolve(() => {
            if (released) {
                return;
            }
            released = true;
            this.release();
        });
    }
}
