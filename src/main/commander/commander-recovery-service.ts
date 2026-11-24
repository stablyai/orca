import { CommanderRecoveryRecorder as Recorder } from './commander-recovery-recorder'
import {
  key,
  changed,
  epoch,
  principal,
  isMissing,
  readConsent,
  noteRecoveryAccountChange,
  type Principal
} from './commander-recovery-account'
import { randomUUID } from 'node:crypto'
import { mkdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  CommanderAccount,
  CommanderRecoveryStatus
} from '../../shared/commander/memory-contract'
import {
  getStructuredAgentSessionHost,
  onStructuredAgentSessionHostChanged
} from '../native-chat/agent-session-wire/host/structured-agent-session-registry'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { writeRecoveryJson } from './commander-recovery-outbox'

let runtime: OrcaRuntimeService | null = null
let recorder: Recorder | null = null
let scheduling: Promise<void> = Promise.resolve()
function serialized<T>(job: () => Promise<T>): Promise<T> {
  const result = scheduling.then(job)
  scheduling = result.then(
    () => {},
    () => {}
  )
  return result
}
async function replace(owner: Principal | null, generation: string | null): Promise<void> {
  if (
    recorder &&
    owner &&
    generation === recorder.generation &&
    key(owner.account) === key(recorder.owner.account) &&
    recorder.current()
  ) {
    return
  }
  const prior = recorder
  recorder = null
  await prior?.stop()
  if (runtime && owner && generation && owner.ticket === epoch(owner.account)) {
    recorder = new Recorder(runtime, owner, generation)
    recorder.baseline(getStructuredAgentSessionHost()?.deps.store.listConversations() ?? [])
  }
}

export function refreshCommanderRecovery(): void {
  noteRecoveryAccountChange()
  void serialized(async () => {
    const owner = await principal()
    await replace(owner, owner ? await readConsent(owner.directory) : null)
  }).catch(() => {})
}

export function startCommanderRecovery(service: OrcaRuntimeService): () => void {
  runtime = service
  let stopRecords: (() => void) | undefined
  function subscribe(): void {
    stopRecords?.()
    const store = getStructuredAgentSessionHost()?.deps.store
    if (recorder && store) {
      recorder.baseline(store.listConversations())
    }
    stopRecords = store?.onRecordsChanged((ids) => {
      if (recorder?.current()) {
        for (const id of ids) {
          recorder.observe(id, store.getConversation(id))
        }
      }
    })
  }
  subscribe()
  const stopHost = onStructuredAgentSessionHostChanged(subscribe)
  refreshCommanderRecovery()
  return () => {
    stopHost()
    stopRecords?.()
    runtime = null
    void replace(null, null)
  }
}

export function agentRecovery(
  account: CommanderAccount,
  enabled?: boolean
): Promise<CommanderRecoveryStatus> {
  return serialized(async () => {
    const owner = await principal()
    if (!owner || key(account) !== key(owner.account)) {
      throw new Error('Commander account changed.')
    }
    const currentTicket = owner.ticket
    let generation = await readConsent(owner.directory)
    if (enabled && !generation) {
      await mkdir(owner.directory, { recursive: true, mode: 0o700 })
      generation = randomUUID()
      const committed = await writeRecoveryJson(
        join(owner.directory, 'enabled.json'),
        generation,
        () => currentTicket === epoch(account)
      )
      if (!committed) {
        throw changed()
      }
    } else if (enabled === false && generation) {
      await replace(null, null)
      await rm(join(owner.directory, 'enabled.json'), { force: true })
      await rm(join(owner.directory, generation), { recursive: true, force: true })
      generation = null
    }
    const latest = await principal()
    if (!latest || key(latest.account) !== key(account) || currentTicket !== epoch(account)) {
      throw new Error('Commander account changed.')
    }
    await replace(owner, generation)
    const lastSyncedAt = generation
      ? await stat(join(owner.directory, generation, 'last-synced'))
          .then((s) => s.mtimeMs)
          .catch((e) => {
            if (isMissing(e)) {
              return null
            }
            throw e
          })
      : null
    return {
      enabled: !!generation,
      lastSyncedAt: lastSyncedAt === null ? null : Math.floor(lastSyncedAt),
      error: recorder?.error ?? null
    }
  })
}
