import type { AgentSessionResumeTrigger } from '../../../shared/agent-session-resume-marker'
import type { StructuredAgentSessionHost } from '../../native-chat/agent-session-wire/structured-agent-session-host'
import type { JournalHostDatabase } from '../../native-chat/agent-session-journal/journal-host-database'
import { recordAgentSessionRuntimeEnd } from '../agent-session-runtime-end-record'

export type InstalledRuntime = {
  host: StructuredAgentSessionHost
  adapter: { closeAll(): Promise<void> }
  /** Closed last, once every conversation has drained into it. */
  journalDatabase: JournalHostDatabase
  /** Resolves after every observed adapter exit has published, and every
   *  recovery callback it raised has settled. */
  waitForRecovery: () => Promise<void>
  /** Host bookkeeping that runs on timers, stopped before anything else. */
  stopBackgroundWork?: () => void
}

/** Latch the resume-marker trigger: the startup-ordering ratchet requires the quit call without arguments. */
let teardownTrigger: AgentSessionResumeTrigger = 'quit'

export function setStructuredAgentSessionTeardownTrigger(trigger: AgentSessionResumeTrigger): void {
  teardownTrigger = trigger
}

export function structuredAgentSessionTeardownTrigger(): AgentSessionResumeTrigger {
  return teardownTrigger
}

export async function tearDownRuntime(
  installed: InstalledRuntime,
  trigger: AgentSessionResumeTrigger
): Promise<void> {
  // Record quit before any await so an interrupted shutdown is not mistaken for a crash.
  recordAgentSessionRuntimeEnd(trigger)
  // Stop delivery before recovery can wake queued sends and start children teardown would kill.
  installed.stopBackgroundWork?.()
  installed.host.stopDelivery()
  // Drain an in-flight recovery before stopping children; recovery may still
  // be writing lifecycle rows or acquiring a replacement child.
  await installed.waitForRecovery()
  const failures: unknown[] = []
  // Evict host sessions before closing adapters so disposeSession can prove exit and release leases.
  // Eviction orders child stop, tail drain, settlement and sink unbind; closeAll only backs up unindexed or refused children.
  // Backstop rows have no sink; drain their late exit callbacks before closing the database.
  try {
    await installed.host.flushAllStreamedEvents({ trigger })
  } catch (error) {
    failures.push(error)
  }
  try {
    // Backstop for children eviction never took: unindexed acquisitions and refused evictions.
    await installed.adapter.closeAll()
  } catch (error) {
    failures.push(error)
  }
  // A backstop close can still deliver a final exit callback.
  try {
    await installed.waitForRecovery()
  } catch (error) {
    failures.push(error)
  }
  if (failures.length === 0) {
    // Close only after all sinks drain and conversations settle.
    installed.journalDatabase.close()
    return
  }
  if (failures.length === 1) {
    throw failures[0]
  }
  throw new AggregateError(failures, 'structured agent-session runtime teardown failed')
}
