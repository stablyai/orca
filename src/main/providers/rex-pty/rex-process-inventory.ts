import type { PtyProcessInfo } from '../pty/process-info'
import { RexControl } from './rex-control'
import type { IPtyProvider } from '../pty/provider-contract'
import type { RexSessionStore } from './rex-session-store'
import { inspectRexRecord } from './rex-inspect-record'
import { recoverRexRetirement } from './rex-retirement-recovery'

export async function listRexProcesses(
  endpoint: string,
  store: RexSessionStore,
  opts?: Parameters<IPtyProvider['listProcesses']>[0]
): Promise<PtyProcessInfo[]> {
  const records = await store.list(opts)
  if (!records.length) {
    return []
  }
  const deadline = Math.min(opts?.deadlineMs ?? Infinity, Date.now() + 5000)
  if (deadline <= Date.now()) {
    throw new Error('Rex inventory deadline elapsed')
  }
  const ctl = await RexControl.connect(endpoint)
  const timeout = setTimeout(() => ctl.close(), Math.max(0, deadline - Date.now()))
  try {
    const result: PtyProcessInfo[] = []
    for (const record of records) {
      const pending = await store.retirements.read(record)
      if (pending && (await recoverRexRetirement(ctl, store, record, deadline))) {
        continue
      }
      await store.retirements.assertAvailable(record)
      const entry = await inspectRexRecord(ctl, record)
      await store.retirements.assertAvailable(record)
      if (entry) {
        result.push(entry)
      }
    }
    return result
  } finally {
    clearTimeout(timeout)
    ctl.close()
  }
}
