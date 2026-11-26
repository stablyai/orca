// The process worker's entry is build output, absent when tests run from src/; without this every file's
// first launch waits on a worker that can't load. Tests of worker routing build or mock their own host.
process.env.ORCA_CHILD_PROCESS_WORKER_DISABLED = '1'
