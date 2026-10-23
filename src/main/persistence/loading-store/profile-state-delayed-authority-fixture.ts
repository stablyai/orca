import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, vi } from 'vitest'
import type { AutomationRun } from '../../../shared/automations-types'
import { buildProfileStateCutoverFixture } from '../profile-state-cutover-fixture'
import { ProfileStateSqliteAuthority } from '../profile-state/profile-state-sqlite-authority'
import { writeVersionedProfileStateExport } from '../profile-state/legacy-json/profile-state-versioned-export'
import type {
  AsyncProfileStateAuthority,
  ProfileStateDomainReplacement
} from './profile-state-authority'
import { Store } from './store'
import { toSshExecutionHostId } from '../../../shared/execution-host'

export function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((accept, refuse) => {
    resolve = accept
    reject = refuse
  })
  return { promise, resolve, reject }
}

/** Delay the authority boundary while retaining real SQLite and Store serialization. */
export class DelayedAuthority implements AsyncProfileStateAuthority {
  readonly asynchronous = true
  private next:
    | { started: ReturnType<typeof deferred<void>>; finish: ReturnType<typeof deferred<void>> }
    | undefined
  readonly captures: ProfileStateDomainReplacement[][] = []
  private failNext = false
  readonly close = vi.fn(async () => {
    this.inner.close()
  })

  constructor(readonly inner: ProfileStateSqliteAuthority) {}

  /** Fail the next profile write the way a full disk would, after any paused gate opens. */
  failNextWrite() {
    this.failNext = true
  }

  pause() {
    const gate = { started: deferred<void>(), finish: deferred<void>() }
    this.next = gate
    return gate
  }

  assertWritable() {}
  async abort() {}
  readSerializedState() {
    return this.inner.readSerializedState()
  }
  async assertCurrentRevision() {
    await this.dispatch(() => this.inner.assertCurrentRevision())
  }
  async writeSerializedState(payload: Buffer) {
    const captured = Buffer.from(payload)
    await this.dispatch(() => this.inner.writeSerializedState(captured), true)
  }
  async writeSerializedDomains(replacements: readonly ProfileStateDomainReplacement[]) {
    const captured = structuredClone(replacements)
    this.captures.push([...captured])
    await this.dispatch(() => this.inner.writeSerializedDomains(captured), true)
  }
  async writeCompleteSerializedDomains(replacements: readonly ProfileStateDomainReplacement[]) {
    const captured = structuredClone(replacements)
    this.captures.push([...captured])
    await this.dispatch(() => this.inner.writeCompleteSerializedDomains(captured), true)
  }
  async writeSerializedAutomationRuns(
    replacements: readonly ProfileStateDomainReplacement[],
    runs: readonly AutomationRun[]
  ) {
    const captured = structuredClone(replacements)
    const capturedRuns = structuredClone(runs)
    await this.dispatch(
      () => this.inner.writeSerializedAutomationRuns(captured, capturedRuns),
      true
    )
  }
  async writeJsonExport(path: string) {
    return this.inner.writeJsonExport(path)
  }
  async writeLatestJsonExport(path: string) {
    return writeVersionedProfileStateExport(path, this.inner.writeJsonExport.bind(this.inner))
  }
  async quarantineDatabase(root?: string, reason?: string) {
    return this.inner.quarantineDatabase(root, reason)
  }
  private async dispatch(operation: () => void, write = false) {
    const gate = this.next
    this.next = undefined
    gate?.started.resolve()
    await gate?.finish.promise
    if (write && this.failNext) {
      this.failNext = false
      throw new Error('profile_state_write_failed')
    }
    operation()
  }
}

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) {
    await cleanup()
  }
  vi.restoreAllMocks()
})

export async function fixture(legacyOpenCodeGoApiKey?: string) {
  const directory = mkdtempSync(join(tmpdir(), 'orca-worker-coordination-'))
  const path = join(directory, 'profile-state.db')
  const inner = new ProfileStateSqliteAuthority(path, 'coordination-test')
  const initial = buildProfileStateCutoverFixture(directory)
  inner.writeSerializedState(
    Buffer.from(
      JSON.stringify({
        ...initial,
        settings: {
          ...initial.settings,
          ...(legacyOpenCodeGoApiKey ? { opencodeGoApiKey: legacyOpenCodeGoApiKey } : {})
        }
      })
    )
  )
  const authority = new DelayedAuthority(inner)
  const store = new Store({
    dataFile: join(directory, 'orca-data.json'),
    profileStateAuthority: authority
  })
  cleanups.push(async () => {
    await store.freezeWritesAsync()
    rmSync(directory, { recursive: true, force: true })
  })
  await store.flushPendingOrThrowAsync()
  authority.captures.length = 0
  const readState = () => {
    const reader = new ProfileStateSqliteAuthority(path, 'coordination-test')
    try {
      return JSON.parse(reader.readSerializedState() ?? '{}')
    } finally {
      reader.close()
    }
  }
  return { store, authority, readState }
}

/** The runtime writes a pane before it spawns; a runtime spawn commit binds only that pane. */
export async function admitRuntimeSpawnPane(
  store: Store,
  pane: { worktreeId: string; tabId: string; leafId: string },
  connectionId?: string | null
): Promise<void> {
  await store.admitTerminalPane(
    {
      type: 'createTerminalTab',
      workspace: pane.worktreeId,
      tabId: pane.tabId,
      leafId: pane.leafId
    },
    connectionId ? toSshExecutionHostId(connectionId) : undefined
  )
}
