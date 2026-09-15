import { randomUUID } from 'node:crypto'
import { Sandbox, Snapshot } from '@vercel/sandbox'
import { PORT } from './configuration.mjs'

export function isMissing(error) {
  return error?.json?.error?.code === 'not_found'
}
export function verifyOwner(box, state) {
  if (box.name !== state.name || box.tags?.orcaOwner !== state.owner) {
    throw new Error('Resource ownership mismatch')
  }
}
export function intent(config, credentials, purpose = 'workspace', id = randomUUID()) {
  return {
    id,
    owner: randomUUID(),
    name: `orca-${purpose}-${id}`,
    purpose,
    phase: 'intent',
    teamId: credentials.teamId,
    projectId: credentials.projectId,
    baseSnapshotId: config.snapshotId,
    snapshots: [],
    sessions: [],
    retained: [],
    createdAt: new Date().toISOString()
  }
}
export class Resources {
  constructor(auth, journal, api = { Sandbox, Snapshot }) {
    this.auth = auth
    this.journal = journal
    this.api = api
    const state = journal.value
    if (state.teamId !== auth.teamId || state.projectId !== auth.projectId) {
      throw new Error('Journal project scope mismatch')
    }
  }
  save(patch) {
    this.journal.save({ ...this.journal.value, ...patch })
  }
  async get() {
    try {
      const box = await this.api.Sandbox.get({
        ...this.auth,
        name: this.journal.value.name,
        resume: false
      })
      verifyOwner(box, this.journal.value)
      return box
    } catch (error) {
      if (isMissing(error)) {
        return null
      }
      throw error
    }
  }
  async create(config, options = {}) {
    this.save({ phase: 'creating' })
    const box = await this.api.Sandbox.create({
      ...this.auth,
      name: this.journal.value.name,
      source: config.snapshotId ? { type: 'snapshot', snapshotId: config.snapshotId } : undefined,
      image: config.snapshotId ? undefined : 'vercel/sandbox/node:24',
      resources: { vcpus: 4 },
      ports: [PORT],
      timeout: config.timeoutMs,
      persistent: true,
      snapshotExpiration: 24 * 60 * 60 * 1000,
      keepLastSnapshots: { count: 2 },
      region: config.region,
      tags: { orcaOwner: this.journal.value.owner },
      ...options
    })
    verifyOwner(box, this.journal.value)
    this.save({ phase: 'created', sessions: [box.currentSession().sessionId] })
    return box
  }
  async inventory(box) {
    const state = this.journal.value
    if (box) {
      verifyOwner(box, state)
      const sessions = await (await box.listSessions()).toArray()
      this.save({ sessions: [...new Set([...state.sessions, ...sessions.map((s) => s.id)])] })
    }
    const snapshots = await (
      await this.api.Snapshot.list({ ...this.auth, ...(box ? { name: state.name } : {}) })
    ).toArray()
    const owned = snapshots.filter((s) => this.journal.value.sessions.includes(s.sourceSessionId))
    if (box && owned.length !== snapshots.length) {
      throw new Error('Snapshot has an unrecognized source session')
    }
    this.save({
      snapshots: [...new Set([...this.journal.value.snapshots, ...owned.map((s) => s.id)])]
    })
    return owned
  }
  async suspend() {
    const box = await this.get()
    if (!box) {
      throw new Error('Environment missing; recovery cannot create a replacement')
    }
    if (box.status === 'running') {
      await box.stop()
    } else if (box.status !== 'stopped') {
      throw new Error(`Environment is ${box.status}; retry after transition`)
    }
    const stopped = await this.get()
    if (!stopped || stopped.status !== 'stopped' || !stopped.currentSnapshotId) {
      throw new Error('Stop did not produce recovery state')
    }
    const snapshot = await this.api.Snapshot.get({
      ...this.auth,
      snapshotId: stopped.currentSnapshotId
    })
    if (snapshot.status !== 'created') {
      throw new Error('Recovery snapshot is not ready')
    }
    await this.inventory(stopped)
    this.save({ phase: 'suspended', recoverySnapshotId: snapshot.snapshotId })
  }
  async resume() {
    let box = await this.get()
    if (!box) {
      throw new Error('Environment missing; recovery cannot create a replacement')
    }
    if (box.status === 'stopped') {
      if (!box.currentSnapshotId || box.currentSnapshotId === this.journal.value.baseSnapshotId) {
        throw new Error('Workspace recovery snapshot missing')
      }
      await this.inventory(box)
      const snapshot = await this.api.Snapshot.get({
        ...this.auth,
        snapshotId: box.currentSnapshotId
      })
      if (!this.journal.value.sessions.includes(snapshot.sourceSessionId)) {
        throw new Error('Recovery snapshot ownership mismatch')
      }
      if (snapshot.status !== 'created') {
        throw new Error('Recovery snapshot unavailable')
      }
      await box.resume()
      box = await this.get()
      if (!box) {
        throw new Error('Environment missing; recovery cannot create a replacement')
      }
    }
    if (box.status !== 'running') {
      throw new Error(`Environment is ${box.status}; retry after transition`)
    }
    this.save({
      phase: 'resuming',
      sessions: [...new Set([...this.journal.value.sessions, box.currentSession().sessionId])]
    })
    return box
  }
  async destroy() {
    this.save({ phase: 'deleting' })
    const box = await this.get()
    if (!box && !this.journal.value.sessions.filter(Boolean).length) {
      throw new Error('Creation outcome unknown; retain the journal and retry reconciliation')
    }
    await this.inventory(box)
    if (box) {
      await box.delete()
    }
    if (await this.get()) {
      throw new Error('Environment deletion has not completed')
    }
    // A delete response can be lost; snapshot IDs must be durable before deleting the host.
    await this.inventory(null)
    for (const snapshotId of this.journal.value.snapshots) {
      if (
        snapshotId === this.journal.value.baseSnapshotId ||
        this.journal.value.retained.includes(snapshotId)
      ) {
        continue
      }
      try {
        const snapshot = await this.api.Snapshot.get({ ...this.auth, snapshotId })
        if (!this.journal.value.sessions.includes(snapshot.sourceSessionId)) {
          throw new Error('Snapshot ownership mismatch')
        }
        if (snapshot.status !== 'deleted') {
          await snapshot.delete()
        }
      } catch (error) {
        if (!isMissing(error)) {
          throw error
        }
      }
    }
    for (const snapshotId of this.journal.value.snapshots) {
      if (
        snapshotId === this.journal.value.baseSnapshotId ||
        this.journal.value.retained.includes(snapshotId)
      ) {
        continue
      }
      try {
        const snapshot = await this.api.Snapshot.get({ ...this.auth, snapshotId })
        if (snapshot.status !== 'deleted') {
          throw new Error('Snapshot deletion unconfirmed; retry reconcile')
        }
      } catch (error) {
        if (!isMissing(error)) {
          throw error
        }
      }
    }
    const remaining = await this.inventory(null)
    const unexpected = remaining.filter(
      (s) =>
        s.status !== 'deleted' &&
        !this.journal.value.retained.includes(s.id) &&
        s.id !== this.journal.value.baseSnapshotId
    )
    if (unexpected.length) {
      throw new Error('Snapshot cleanup incomplete; retry reconcile')
    }
    this.save({ phase: 'deleted' })
  }
}
