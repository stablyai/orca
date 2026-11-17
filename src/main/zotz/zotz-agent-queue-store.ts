import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { renameFileWithWindowsRetryAsync } from '../../shared/file-write/windows-retry-file-operations'
import {
  createZotzAgentQueue,
  normalizeZotzAgentQueue,
  type ZotzAgentQueue
} from '../../shared/zotz/agent-queue/zotz-agent-queue'
import {
  normalizeZotzAgentMemoryLedger,
  type ZotzAgentMemoryLedger
} from '../../shared/zotz/agent-queue/zotz-agent-memory-ledger'

const QUEUE_FILE = 'zotz-agent-queue.json'
const LEDGER_FILE = 'zotz-agent-memory-ledger.json'

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch {
    // Missing or corrupt state starts empty; a corrupt file is replaced on the next save.
    return undefined
  }
}

async function writeJsonAtomically(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
    await renameFileWithWindowsRetryAsync(temporary, path)
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined)
  }
}

/** Keeps the agent backlog and the memory ledger on disk so queued tasks survive restarts. */
export class ZotzAgentQueueStore {
  // Saves run one at a time so a slow write never lands after a newer one.
  private pendingWrite: Promise<void> = Promise.resolve()

  constructor(private readonly userDataPath: string) {}

  async loadQueue(): Promise<ZotzAgentQueue> {
    const stored = await readJson(join(this.userDataPath, QUEUE_FILE))
    return stored === undefined ? createZotzAgentQueue() : normalizeZotzAgentQueue(stored)
  }

  async loadLedger(): Promise<ZotzAgentMemoryLedger> {
    return normalizeZotzAgentMemoryLedger(await readJson(join(this.userDataPath, LEDGER_FILE)))
  }

  saveQueue(queue: ZotzAgentQueue): Promise<void> {
    return this.enqueueWrite(join(this.userDataPath, QUEUE_FILE), queue)
  }

  saveLedger(ledger: ZotzAgentMemoryLedger): Promise<void> {
    return this.enqueueWrite(join(this.userDataPath, LEDGER_FILE), ledger)
  }

  private enqueueWrite(path: string, value: unknown): Promise<void> {
    const write = this.pendingWrite.then(() => writeJsonAtomically(path, value))
    this.pendingWrite = write.catch(() => undefined)
    return write
  }
}
